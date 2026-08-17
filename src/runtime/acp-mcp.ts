// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Translate Bivy's MCP config (a name->spec MAP, the shape Claude/Gemini/generic
// hosts use) into the ARRAY of ACP mcpServer objects that ACP's session/new and
// session/load expect. The ACP shim (bin/acp-shim.mjs) reads the
// serialized result from BIVY_ACP_MCP_SERVERS and forwards it — previously it
// hardcoded `[]`, cutting ACP agents off from MCP (including Bivy's own tools
// server). Pure + unit-tested so the mapping can't silently regress.

import type { McpConfig, McpServerSpec } from "../harness/mcp-config.js";

/** An ACP mcpServer entry. stdio servers carry command/args/env (env as the
 *  ACP [{name,value}] array); remote servers carry a url/type. */
export interface AcpMcpServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  url?: string;
  type?: string;
}

function envToAcp(env: Record<string, string> | undefined): Array<{ name: string; value: string }> | undefined {
  if (!env) return undefined;
  const entries = Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
  return entries.length ? entries : undefined;
}

/** Convert one Bivy server spec to ACP shape. Remote (url) servers pass through
 *  as an http/sse entry; stdio servers as command/args/env. Returns null for a
 *  spec that is neither (nothing runnable to advertise). */
export function acpMcpServer(name: string, spec: McpServerSpec): AcpMcpServer | null {
  if (spec.url) {
    return { name, url: spec.url, type: typeof spec.type === "string" ? spec.type : "http" };
  }
  if (spec.command) {
    const env = envToAcp(spec.env);
    return { name, command: spec.command, args: spec.args ?? [], ...(env ? { env } : {}) };
  }
  return null;
}

/** Translate a full Bivy MCP config into the ACP server array. */
export function acpMcpServersFromConfig(config: McpConfig | undefined): AcpMcpServer[] {
  const servers = config?.mcpServers ?? {};
  const out: AcpMcpServer[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    const mapped = acpMcpServer(name, spec);
    if (mapped) out.push(mapped);
  }
  return out;
}

/** Serialize a config to the BIVY_ACP_MCP_SERVERS env value, or undefined when
 *  there is nothing to advertise (so the shim keeps its empty default). */
export function serializeAcpMcpEnv(config: McpConfig | undefined): string | undefined {
  const servers = acpMcpServersFromConfig(config);
  return servers.length ? JSON.stringify(servers) : undefined;
}
