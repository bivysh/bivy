// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Universal Agent Harness — MCP config rewriting.
//
// The one piece of MCP governance that is unavoidably per-agent is *where* the
// config lives — but the shape is near-universal. Claude Code, Codex, Cursor,
// Windsurf, and most MCP hosts use the same `{ mcpServers: { name: { command,
// args, env } } }` object (stdio servers) plus optional remote (url) servers.
// This module rewrites that object so every stdio server launches through the
// Bivy MCP proxy instead of directly — turning each agent's own MCP config into
// the injection point, with no agent-specific code beyond the file location.
//
// Pure functions, no I/O — unit-tested in test/harness-mcp-config.test.ts. The
// file-location table for each agent is data (see agentMcpConfigTargets) that
// the fs inject/restore step (mcp-inject.ts) reads/writes; the transform itself
// is shared.

import nodePath from "node:path";

export interface McpServerSpec {
  /** stdio server: executable to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** remote server: SSE/HTTP endpoint (not proxied by the stdio proxy yet). */
  url?: string;
  type?: string;
  [k: string]: unknown;
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerSpec>;
  [k: string]: unknown;
}

/** How to launch the Bivy MCP proxy, e.g. { command: "bivy", argsPrefix: ["mcp-proxy"] }. */
export interface ProxyLauncher {
  command: string;
  /** Args before the per-server routing args (e.g. ["mcp-proxy"]). */
  argsPrefix?: string[];
}

export interface RouteResult {
  /** The rewritten config (a deep-ish copy; the input is not mutated). */
  config: McpConfig;
  /** Names of stdio servers that were routed through the proxy. */
  rewritten: string[];
  /** Names of servers left untouched (remote/url servers, or already-proxied). */
  skipped: string[];
}

/** Marker arg the proxy CLI recognizes, so a config can be detected as already routed. */
export const PROXY_MARKER = "--bivy-mcp";

/** True when a server spec already launches through the Bivy proxy. */
export function isProxied(spec: McpServerSpec, launcher: ProxyLauncher): boolean {
  if (spec.command !== launcher.command) return false;
  return Array.isArray(spec.args) && spec.args.includes(PROXY_MARKER);
}

/**
 * Rewrite every stdio server in `config.mcpServers` to launch through the proxy:
 *
 *   original:  { command: "mcp-fs", args: ["--root", "/w"], env: {...} }
 *   rewritten: { command: "bivy",
 *                args: ["mcp-proxy", "--bivy-mcp", "--server", "<name>", "--",
 *                       "mcp-fs", "--root", "/w"],
 *                env: {...} }
 *
 * Remote (url) servers are left untouched and reported in `skipped`. Idempotent:
 * an already-proxied server is left as-is (also reported in `skipped`).
 */
export function routeThroughProxy(config: McpConfig, launcher: ProxyLauncher): RouteResult {
  const rewritten: string[] = [];
  const skipped: string[] = [];
  const servers = config.mcpServers ?? {};
  const nextServers: Record<string, McpServerSpec> = {};

  for (const [name, spec] of Object.entries(servers)) {
    if (!spec || typeof spec !== "object") {
      nextServers[name] = spec;
      skipped.push(name);
      continue;
    }
    if (typeof spec.command !== "string" || !spec.command) {
      // Remote/url server (or malformed) — the stdio proxy can't wrap it yet.
      nextServers[name] = spec;
      skipped.push(name);
      continue;
    }
    if (isProxied(spec, launcher)) {
      nextServers[name] = spec;
      skipped.push(name);
      continue;
    }
    const prefix = launcher.argsPrefix ?? [];
    nextServers[name] = {
      ...spec,
      command: launcher.command,
      args: [...prefix, PROXY_MARKER, "--server", name, "--", spec.command, ...(spec.args ?? [])],
    };
    rewritten.push(name);
  }

  return {
    config: { ...config, mcpServers: nextServers },
    rewritten,
    skipped,
  };
}

/**
 * Recover the original server command/args from a proxied spec's args — the
 * inverse of routeThroughProxy, used by the proxy CLI to know what to spawn.
 * Returns null if the args don't carry a `-- <command> ...` tail.
 */
export function parseProxiedArgs(args: string[]): { server?: string; command: string; args: string[] } | null {
  const sep = args.indexOf("--");
  if (sep < 0 || sep + 1 >= args.length) return null;
  const serverFlag = args.indexOf("--server");
  const server = serverFlag >= 0 && serverFlag + 1 < sep ? args[serverFlag + 1] : undefined;
  const tail = args.slice(sep + 1);
  return { server, command: tail[0], args: tail.slice(1) };
}

// ---------------------------------------------------------------------------
// Phase 2b — auto-injection into an agent's on-disk MCP config.
//
// The transform above is universal; the only per-agent bit is *where* the JSON
// config lives. This table lists the JSON MCP-config files each agent reads
// (workspace-local first, so injection is session-scoped and safe). Agents whose
// config is TOML/YAML (Codex, Goose) are intentionally omitted for now — routing
// them needs a format-specific writer; they still run + are governed by the FS
// and network channels, just without proxied MCP.

export interface McpConfigContext {
  /** The session workspace (for workspace-local config files). */
  workspace: string;
  /** The user's home dir (for global config files). */
  home: string;
}

/** JSON MCP-config file candidates for an agent, most-specific (safest) first. */
export function agentMcpConfigTargets(agentId: string, ctx: McpConfigContext): string[] {
  const ws = (...parts: string[]) => nodePath.join(ctx.workspace, ...parts);
  const home = (...parts: string[]) => nodePath.join(ctx.home, ...parts);
  switch (agentId) {
    case "claude":
    case "claude-code":
    case "claude-code-sdk":
      return [ws(".mcp.json")];
    case "gemini":
      return [ws(".gemini", "settings.json"), home(".gemini", "settings.json")];
    case "opencode":
      return [ws("opencode.json"), ws(".opencode.json")];
    case "codex":
      // Codex stores MCP servers in TOML.
      return [home(".codex", "config.toml")];
    case "goose":
      // Goose stores MCP "extensions" in YAML.
      return [home(".config", "goose", "config.yaml")];
    default:
      // A generic project-local MCP config many hosts honor.
      return [ws(".mcp.json")];
  }
}
