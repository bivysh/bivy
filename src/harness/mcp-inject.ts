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
// Only JSON configs are handled (Claude, Gemini, OpenCode, generic .mcp.json).
// TOML/YAML-config agents are skipped — they still run and are governed by the
// FS + network channels. Unit-tested in test/harness-mcp-inject.test.ts.

import fs from "node:fs";
import path from "node:path";
import {
  agentMcpConfigTargets,
  routeThroughProxy,
  type McpConfig,
  type McpConfigContext,
  type ProxyLauncher,
} from "./mcp-config.js";
import { injectTomlMcp, injectYamlMcp } from "./mcp-config-formats.js";

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
 * servers to route). Never throws.
 */
export function injectJsonMcpConfig(filePath: string, launcher: ProxyLauncher): { injected: boolean; restore: () => void } {
  let original: string;
  try {
    original = fs.readFileSync(filePath, "utf8");
  } catch {
    return { injected: false, restore: () => {} };
  }
  let parsed: McpConfig;
  try {
    parsed = JSON.parse(original) as McpConfig;
  } catch {
    return { injected: false, restore: () => {} };
  }
  const result = routeThroughProxy(parsed, launcher);
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
