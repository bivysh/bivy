// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Universal Agent Harness — `bivy mcp-proxy` entry point.
//
// The agent launches its MCP servers through this (via routeThroughProxy config
// rewriting): `bivy mcp-proxy --bivy-mcp --server <name> -- <real cmd> <args>`.
// This process spawns the real server and mediates its JSON-RPC, asking the
// local Bivy daemon to decide each `tools/call` — which runs the SAME guardian /
// PolicyEngine / ApprovalCard path as native tool calls, so MCP tools are
// governed identically for every agent.
//
// Fail-open by design: if the daemon is unreachable, the proxy must never break
// the agent — it allows the call and logs to stderr. Governance is a safety net,
// not a hard dependency that can wedge a user's agent when the node restarts.
//
// The HTTP decider is factored out and unit-tested (test/harness-mcp-cli.test.ts)
// with an injected fetch; the process wiring itself is thin.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMcpProxy, type McpDecider, type McpEvent } from "./mcp-proxy.js";
import { parseProxiedArgs } from "./mcp-config.js";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

const DEFAULT_ENDPOINT = "http://127.0.0.1:4317";

/**
 * Build a decider that asks the daemon whether an MCP `tools/call` may run.
 * Fail-open on any transport/HTTP error so a down node never wedges the agent.
 */
export function buildHttpDecider(endpoint: string, sessionId: string, server: string, fetchImpl: FetchLike): McpDecider {
  return async (tool, args) => {
    try {
      const r = await fetchImpl(`${endpoint}/api/mcp/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, server, tool, args }),
      });
      if (!r.ok) return { allow: true };
      const j = (await r.json()) as { allow?: unknown; reason?: unknown };
      return { allow: j.allow !== false, reason: typeof j.reason === "string" ? j.reason : undefined };
    } catch {
      return { allow: true }; // fail-open
    }
  };
}

/** Best-effort event post (inventory / results). Never throws. */
function reportEvent(endpoint: string, sessionId: string, event: McpEvent, fetchImpl: FetchLike): void {
  void fetchImpl(`${endpoint}/api/mcp/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, event }),
  }).catch(() => {});
}

export interface McpProxyCliDeps {
  endpoint?: string;
  sessionId?: string;
  fetchImpl?: FetchLike;
}

/** Parse `bivy mcp-proxy` args and run the proxy. Returns the child exit code. */
export async function runMcpProxyCli(argv: string[], deps: McpProxyCliDeps = {}): Promise<number> {
  const parsed = parseProxiedArgs(argv);
  if (!parsed || !parsed.command) {
    process.stderr.write("bivy mcp-proxy: expected `--server <name> -- <command> [args…]`\n");
    return 2;
  }
  const endpoint = deps.endpoint ?? process.env.BIVY_MCP_ENDPOINT ?? DEFAULT_ENDPOINT;
  const sessionId = deps.sessionId ?? process.env.BIVY_MCP_SESSION ?? "";
  const server = parsed.server ?? "mcp";
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  return await runMcpProxy({
    command: parsed.command,
    args: parsed.args,
    server,
    decide: buildHttpDecider(endpoint, sessionId, server, fetchImpl),
    // The daemon already records the call via /api/mcp/decide; only forward the
    // inventory and result events here to avoid double-counting.
    onEvent: (event) => {
      if (event.type !== "call") reportEvent(endpoint, sessionId, event, fetchImpl);
    },
  });
}

// Run when invoked directly (via `bivy mcp-proxy …` → tsx this file).
const invokedDirectly = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  void runMcpProxyCli(process.argv.slice(2)).then((code) => process.exit(code));
}
