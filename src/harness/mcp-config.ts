// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Universal Agent Harness — MCP config rewriting.
//
// The one piece of MCP governance that is unavoidably per-agent is *where* the
// config lives — and, for a couple of hosts, the shape. Claude Code, Cursor,
// Windsurf, and most MCP hosts use `{ mcpServers: { name: { command, args, env
// } } }` (stdio) plus optional remote (url) servers. OpenCode is the JSON
// outlier: `{ mcp: { name: { type: "local", command: [bin, ...args],
// environment } } }` (see opencode.ai/config.json). This module rewrites both
// shapes so every stdio server launches through the Bivy MCP proxy instead of
// directly — turning each agent's own MCP config into the injection point.
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
// Bivy-owned tools server — the mirror of the proxy above. routeThroughProxy
// wraps the agent's OWN servers; this ADDS a `bivy` server (run via `bivy
// mcp-serve`) so the agent discovers Bivy's chat tools (attach_to_chat, …) in
// its own tool list. Session id + node URL ride in its env so the tool can post
// back to the right session.

/** The server spec that launches `bivy mcp-serve` for a session. */
export function bivyToolsServerSpec(opts: { sessionId: string; endpoint?: string; bivyCommand?: string }): McpServerSpec {
  const env: Record<string, string> = { BIVY_SESSION_ID: opts.sessionId };
  if (opts.endpoint) env.BIVY_MCP_ENDPOINT = opts.endpoint;
  return { command: opts.bivyCommand ?? "bivy", args: ["mcp-serve"], env };
}

/**
 * Insert the Bivy tools server under `mcpServers.<name>` (default "bivy").
 * Idempotent: an existing entry of that name is left untouched (returns
 * `added: false`), so a re-inject or a user's own `bivy` server never doubles up.
 */
export function withBivyToolsServer(config: McpConfig, spec: McpServerSpec, name = "bivy"): { config: McpConfig; added: boolean } {
  const servers = config.mcpServers ?? {};
  if (servers[name]) return { config, added: false };
  return { config: { ...config, mcpServers: { ...servers, [name]: spec } }, added: true };
}

// ---------------------------------------------------------------------------
// OpenCode — same job as the mcpServers helpers above, different JSON shape.
// OpenCode's schema rejects unknown top-level keys (additionalProperties: false),
// so writing `mcpServers` makes `opencode run` fail immediately with
// "Unrecognized key: mcpServers". Local servers use `command` as a full argv
// array and `environment` (not `args`/`env`).

/** One entry under OpenCode's top-level `mcp` map. */
export interface OpenCodeMcpServerSpec {
  type?: "local" | "remote" | string;
  /** Local: full argv, e.g. `["bivy", "mcp-serve"]`. */
  command?: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
  cwd?: string;
  timeout?: number;
  /** Remote: SSE/HTTP endpoint. */
  url?: string;
  headers?: Record<string, string>;
  [k: string]: unknown;
}

export interface OpenCodeConfig {
  mcp?: Record<string, OpenCodeMcpServerSpec>;
  [k: string]: unknown;
}

/** Convert a universal stdio server spec into OpenCode's local-server shape. */
export function toOpenCodeLocalServer(spec: McpServerSpec): OpenCodeMcpServerSpec {
  const command = [spec.command ?? "", ...(spec.args ?? [])].filter((s, i) => i === 0 || s !== undefined);
  // Drop a leading empty command if somehow absent — callers always pass one.
  const argv = command[0] ? command : command.slice(1);
  const out: OpenCodeMcpServerSpec = { type: "local", command: argv };
  if (spec.env && Object.keys(spec.env).length) out.environment = { ...spec.env };
  return out;
}

/** True when an OpenCode local server already launches through the Bivy proxy. */
export function isOpenCodeProxied(spec: OpenCodeMcpServerSpec, launcher: ProxyLauncher): boolean {
  if (!Array.isArray(spec.command) || spec.command.length === 0) return false;
  if (spec.command[0] !== launcher.command) return false;
  return spec.command.includes(PROXY_MARKER);
}

/**
 * Rewrite every local stdio server in `config.mcp` to launch through the proxy:
 *
 *   original:  { type: "local", command: ["mcp-fs", "--root", "/w"], environment: {...} }
 *   rewritten: { type: "local",
 *                command: ["bivy", "mcp-proxy", "--bivy-mcp", "--server", "<name>", "--",
 *                          "mcp-fs", "--root", "/w"],
 *                environment: {...} }
 *
 * Remote servers and already-proxied locals are left untouched (reported in
 * `skipped`). Idempotent. Does not mutate the input.
 */
export function routeOpenCodeThroughProxy(config: OpenCodeConfig, launcher: ProxyLauncher): RouteResult & { config: OpenCodeConfig } {
  const rewritten: string[] = [];
  const skipped: string[] = [];
  const servers = config.mcp ?? {};
  const nextServers: Record<string, OpenCodeMcpServerSpec> = {};

  for (const [name, spec] of Object.entries(servers)) {
    if (!spec || typeof spec !== "object") {
      nextServers[name] = spec;
      skipped.push(name);
      continue;
    }
    if (!Array.isArray(spec.command) || spec.command.length === 0 || typeof spec.command[0] !== "string" || !spec.command[0]) {
      // Remote/url server, enabled-only stub, or malformed — can't wrap via stdio proxy.
      nextServers[name] = spec;
      skipped.push(name);
      continue;
    }
    if (isOpenCodeProxied(spec, launcher)) {
      nextServers[name] = spec;
      skipped.push(name);
      continue;
    }
    const prefix = launcher.argsPrefix ?? [];
    const orig = spec.command;
    nextServers[name] = {
      ...spec,
      type: "local",
      command: [launcher.command, ...prefix, PROXY_MARKER, "--server", name, "--", ...orig],
    };
    rewritten.push(name);
  }

  return {
    config: { ...config, mcp: nextServers },
    rewritten,
    skipped,
  };
}

/**
 * Insert the Bivy tools server under OpenCode's `mcp.<name>` (default "bivy").
 * Idempotent: an existing entry of that name is left untouched.
 */
export function withOpenCodeBivyToolsServer(
  config: OpenCodeConfig,
  spec: OpenCodeMcpServerSpec,
  name = "bivy",
): { config: OpenCodeConfig; added: boolean } {
  const servers = config.mcp ?? {};
  if (servers[name]) return { config, added: false };
  return { config: { ...config, mcp: { ...servers, [name]: spec } }, added: true };
}

/** Basename check for OpenCode project config files we inject into. */
export function isOpenCodeConfigFile(filePath: string): boolean {
  const base = nodePath.basename(filePath).toLowerCase();
  return base === "opencode.json" || base === ".opencode.json" || base === "opencode.jsonc" || base === ".opencode.jsonc";
}

// ---------------------------------------------------------------------------
// Phase 2b — auto-injection into an agent's on-disk MCP config.
//
// The transform above is shared; the per-agent bit is *where* the config lives
// (and for OpenCode/Codex/Goose, which writer to use). This table lists the
// MCP-config files each agent reads (workspace-local first, so injection is
// session-scoped and safe).

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
