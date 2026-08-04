// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Universal Agent Harness — MCP config auto-injection (fs side).
//
// Phase 2b: at session start, rewrite the agent's on-disk JSON MCP config so its
// stdio servers launch through `bivy mcp-proxy` (routeThroughProxy), and hand
// back a restore() that puts the file back exactly as it was on session end.
// Opt-in via BIVY_MCP_PROXY so it never surprises a user. Best-effort and
// session-scoped (workspace-local files preferred) so a failure or a concurrent
// session can't corrupt config: we snapshot the exact bytes and restore them.
//
// JSON configs (Claude, Gemini, generic .mcp.json) use the universal
// `mcpServers` shape; OpenCode's project `opencode.json` uses its own `mcp`
// shape (see routeOpenCodeThroughProxy). TOML/YAML (Codex, Goose) go through
// the format-specific writers. Unit-tested in test/harness-mcp-inject.test.ts.

import fs from "node:fs";
import path from "node:path";
import {
  agentMcpConfigTargets,
  bivyToolsServerSpec,
  isOpenCodeConfigFile,
  routeOpenCodeThroughProxy,
  routeThroughProxy,
  toOpenCodeLocalServer,
  withBivyToolsServer,
  withOpenCodeBivyToolsServer,
  type McpConfig,
  type McpConfigContext,
  type OpenCodeConfig,
  type ProxyLauncher,
} from "./mcp-config.js";
import { injectTomlMcp, injectYamlMcp, insertTomlServer } from "./mcp-config-formats.js";

export interface InjectResult {
  /** Files that were rewritten to route MCP servers through the proxy. */
  injected: string[];
  /** Undo all rewrites, restoring each file's original bytes exactly. */
  restore: () => void;
}

/** The proxy launcher Bivy injects — `bivy mcp-proxy …`. */
export function bivyProxyLauncher(bivyCommand = "bivy"): ProxyLauncher {
  return { command: bivyCommand, argsPrefix: ["mcp-proxy"] };
}

/**
 * Inject the proxy into a single JSON config file. Returns a restore thunk
 * (a no-op if the file was absent, unreadable, non-JSON, or had no stdio
 * servers to route). OpenCode project configs (`opencode.json`) use the
 * OpenCode `mcp` shape; everything else uses the universal `mcpServers` shape.
 * Never throws.
 */
export function injectJsonMcpConfig(filePath: string, launcher: ProxyLauncher): { injected: boolean; restore: () => void } {
  let original: string;
  try {
    original = fs.readFileSync(filePath, "utf8");
  } catch {
    return { injected: false, restore: () => {} };
  }
  let parsed: McpConfig | OpenCodeConfig;
  try {
    parsed = JSON.parse(original) as McpConfig | OpenCodeConfig;
  } catch {
    return { injected: false, restore: () => {} };
  }
  const result = isOpenCodeConfigFile(filePath)
    ? routeOpenCodeThroughProxy(parsed as OpenCodeConfig, launcher)
    : routeThroughProxy(parsed as McpConfig, launcher);
  if (result.rewritten.length === 0) return { injected: false, restore: () => {} };

  // Preserve the file's indentation feel by re-serializing with 2 spaces; the
  // restore path writes back the exact original bytes regardless.
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(result.config, null, 2)}\n`);
  } catch {
    return { injected: false, restore: () => {} };
  }
  return {
    injected: true,
    restore: () => {
      try {
        fs.writeFileSync(filePath, original);
      } catch {
        // Restore is best-effort; the original bytes are all we can offer.
      }
    },
  };
}

/**
 * Inject the proxy into a single MCP config file, dispatching on extension:
 * .json (universal), .toml (Codex), .yaml/.yml (Goose). Reads → transforms →
 * writes, returning an exact-bytes restore(). Never throws; no-op when the file
 * is absent, unparseable, or has no stdio server to route.
 */
export function injectMcpConfigFile(filePath: string, launcher: ProxyLauncher): { injected: boolean; restore: () => void } {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") return injectJsonMcpConfig(filePath, launcher);

  let original: string;
  try {
    original = fs.readFileSync(filePath, "utf8");
  } catch {
    return { injected: false, restore: () => {} };
  }
  let out: { content: string; rewritten: string[] };
  try {
    if (ext === ".toml") out = injectTomlMcp(original, launcher);
    else if (ext === ".yaml" || ext === ".yml") out = injectYamlMcp(original, launcher);
    else return { injected: false, restore: () => {} };
  } catch {
    return { injected: false, restore: () => {} };
  }
  if (out.rewritten.length === 0) return { injected: false, restore: () => {} };
  try {
    fs.writeFileSync(filePath, out.content);
  } catch {
    return { injected: false, restore: () => {} };
  }
  return {
    injected: true,
    restore: () => {
      try { fs.writeFileSync(filePath, original); } catch { /* best-effort */ }
    },
  };
}

/** Context for injecting the Bivy tools server: the session it serves + node URL. */
export interface BivyToolsContext extends McpConfigContext {
  sessionId: string;
  /** Node URL the tool posts back to (BIVY_MCP_ENDPOINT); default loopback. */
  endpoint?: string;
}

/**
 * Add the `bivy` tools server (attach_to_chat …) to an agent's MCP config so the
 * agent DISCOVERS it as a tool. Unlike the proxy inject (which only rewrites
 * servers a file already has), this CREATES the config when absent so an agent
 * that ships no MCP config still gets the tool. Handles the most-specific JSON
 * config (session-local for claude/gemini/opencode/generic) and Codex's TOML
 * (`~/.codex/config.toml` — Codex has no project-local option). OpenCode gets
 * its native `{ mcp: { bivy: { type: "local", command: [...] } } }` shape — the
 * universal `mcpServers` key is rejected by OpenCode's schema. restore() deletes
 * a file it created and rewrites the exact original bytes of one it modified.
 * Idempotent (a `bivy` server already present is a no-op, so concurrent sessions
 * sharing a global config don't double up). Best-effort; never throws. Goose YAML
 * is a follow-up.
 */
export function injectBivyToolsForSession(agentId: string, ctx: BivyToolsContext, bivyCommand = "bivy"): InjectResult {
  const target = agentMcpConfigTargets(agentId, ctx).find((t) => {
    const ext = path.extname(t).toLowerCase();
    return ext === ".json" || ext === ".toml";
  });
  if (!target) return { injected: [], restore: () => {} };
  const spec = bivyToolsServerSpec({ sessionId: ctx.sessionId, endpoint: ctx.endpoint, bivyCommand });
  const ext = path.extname(target).toLowerCase();
  const openCode = agentId === "opencode" || isOpenCodeConfigFile(target);

  const existed = fs.existsSync(target);
  let original: string | undefined;
  if (existed) {
    try {
      original = fs.readFileSync(target, "utf8");
    } catch {
      return { injected: [], restore: () => {} };
    }
  }

  let nextContent: string;
  if (ext === ".json" && openCode) {
    let parsed: OpenCodeConfig = {};
    if (original !== undefined) {
      try {
        parsed = JSON.parse(original) as OpenCodeConfig;
      } catch {
        return { injected: [], restore: () => {} };
      }
    }
    const { config, added } = withOpenCodeBivyToolsServer(parsed, toOpenCodeLocalServer(spec));
    if (!added) return { injected: [], restore: () => {} };
    nextContent = `${JSON.stringify(config, null, 2)}\n`;
  } else if (ext === ".json") {
    let parsed: McpConfig = {};
    if (original !== undefined) {
      try {
        parsed = JSON.parse(original) as McpConfig;
      } catch {
        // A config we can't parse is not ours to rewrite — leave it be.
        return { injected: [], restore: () => {} };
      }
    }
    const { config, added } = withBivyToolsServer(parsed, spec);
    if (!added) return { injected: [], restore: () => {} };
    nextContent = `${JSON.stringify(config, null, 2)}\n`;
  } else {
    const res = insertTomlServer(original ?? "", "bivy", { command: spec.command ?? bivyCommand, args: spec.args, env: spec.env });
    if (!res.inserted) return { injected: [], restore: () => {} };
    nextContent = res.content;
  }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, nextContent);
  } catch {
    return { injected: [], restore: () => {} };
  }
  return {
    injected: [target],
    restore: () => {
      try {
        if (existed && original !== undefined) fs.writeFileSync(target, original);
        else fs.rmSync(target, { force: true });
      } catch {
        // Restore is best-effort.
      }
    },
  };
}

/**
 * Inject the proxy into every MCP config an agent reads for this session.
 * Returns the injected files and a single restore() covering all of them.
 */
export function injectMcpProxyForSession(
  agentId: string,
  ctx: McpConfigContext,
  launcher: ProxyLauncher = bivyProxyLauncher(),
): InjectResult {
  const restores: (() => void)[] = [];
  const injected: string[] = [];
  for (const target of agentMcpConfigTargets(agentId, ctx)) {
    const r = injectMcpConfigFile(target, launcher);
    if (r.injected) {
      injected.push(target);
      restores.push(r.restore);
    }
  }
  return {
    injected,
    restore: () => {
      for (const r of restores) r();
    },
  };
}
