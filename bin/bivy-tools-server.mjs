// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The `bivy mcp-serve` server (Bivy's own agent tools: ask_user, notify_user,
// attach_to_chat, …) for the session this process serves. The protocol shims
// (acp-shim.mjs, codex-app-server-shim.mjs) run once per session with that
// session's BIVY_SESSION_ID / BIVY_SESSION_TOKEN in their env, so each hands
// its agent this server in the agent's own per-session channel: ACP's
// session/new `mcpServers`, Codex's `-c mcp_servers.*`. No config file is
// written, so concurrent sessions never share one entry.
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIVY_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "bivy.mjs");

/** What the server needs to reach this session on this node. */
export const BIVY_TOOLS_ENV = ["BIVY_SESSION_ID", "BIVY_SESSION_TOKEN", "BIVY_MCP_ENDPOINT", "BIVY_AGENT_INSTRUCTIONS_FILE"];

/** `{ name, command, args, env }` for this session's tools server, or undefined
 *  outside a Bivy session. */
export function bivyToolsServer(env = process.env) {
  if (!env.BIVY_SESSION_ID) return undefined;
  const serverEnv = Object.fromEntries(BIVY_TOOLS_ENV.filter((name) => env[name]).map((name) => [name, env[name]]));
  return { name: "bivy", command: process.execPath, args: [BIVY_CLI, "mcp-serve"], env: serverEnv };
}

/** The server as an ACP `mcpServers` entry (env as [{ name, value }]). */
export function acpBivyToolsServer(env = process.env) {
  const server = bivyToolsServer(env);
  if (!server) return undefined;
  return { ...server, env: Object.entries(server.env).map(([name, value]) => ({ name, value })) };
}

/** The server as Codex `-c` overrides. The env is forwarded by name
 *  (`env_vars`), so the session token stays off the command line. */
export function codexBivyToolsArgs(env = process.env) {
  const server = bivyToolsServer(env);
  if (!server) return [];
  const key = `mcp_servers.${server.name}`;
  return [
    "-c", `${key}.command=${JSON.stringify(server.command)}`,
    "-c", `${key}.args=${JSON.stringify(server.args)}`,
    "-c", `${key}.env_vars=${JSON.stringify(Object.keys(server.env))}`,
  ];
}
