// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Universal Agent Harness — `bivy mcp-serve` entry point.
//
// A Bivy-OWNED stdio MCP server (the mirror of `bivy mcp-proxy`, which wraps the
// agent's OWN servers). Injected into every non-SDK agent's MCP config at session
// start (see mcp-inject.ts's injectBivyToolsForSession), it exposes Bivy's chat
// affordances as first-class tools so ANY agent — codex, gemini, aider, opencode,
// … — discovers them in its tool list instead of having to be told about a shell
// command (issue #290). Today it serves one tool, `attach_to_chat`.
//
// Claude and Pi already get `attach_to_chat` natively (in-process SDK MCP server /
// integration ToolProvider); this covers everyone else. The tool just POSTs to the
// node's existing `POST /api/session/:id/attach` endpoint — the exact plumbing
// `bivy attach` uses — so it reuses the same workspace confinement, storage, and
// live broadcast. The session id and node URL arrive via env (BIVY_SESSION_ID /
// BIVY_MCP_ENDPOINT), stamped into the injected server spec.
//
// The attach client is factored out and unit-tested (test/harness-mcp-serve.test.ts)
// with an injected fetch; the process/transport wiring is thin.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:4317";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** The tools this server advertises, in MCP `tools/list` shape. */
export const BIVY_MCP_TOOLS = [
  {
    name: "attach_to_chat",
    description:
      "Send a file or image from the session workspace into the chat the user is reading. The person you're " +
      "talking to is in a chat UI: they cannot see files you only write to disk, and the chat cannot load workspace " +
      "paths or remote image URLs. Use this to show them a report, screenshot, chart, or any file they asked for. An " +
      "image renders inline; any other file shows as a downloadable chip. The path must be inside the session " +
      "workspace. Prefer this over pasting large file contents, describing where a file lives, or markdown image " +
      "syntax (which will not render).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to send, inside the session workspace (absolute, or relative to it)." },
        caption: { type: "string", description: "Optional short note shown with the attachment." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "start_run",
    description: "Delegate one bounded task to another governed Bivy Run or Machine. Returns lifecycle and safe references only, never the child transcript, raw tool output, secrets, or file contents.",
    inputSchema: { type: "object", properties: { instructions: { type: "string", maxLength: 16000 }, repo: { type: "string" }, machine: { type: "string" }, agent: { type: "string" }, model: { type: "string" }, safety: { type: "object", properties: { approval: { type: "string", enum: ["never", "risky", "always", "autonomous"] }, sandbox: { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"] }, maxAttempts: { type: "integer", minimum: 1, maximum: 10 } }, additionalProperties: false }, idempotencyKey: { type: "string", maxLength: 128 } }, required: ["instructions"], additionalProperties: false },
  },
  {
    name: "get_run_status",
    description: "Inspect a child Run started by this Session. Returns bounded lifecycle, check states, and safe output references only.",
    inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false },
  },
  {
    name: "wait_for_run",
    description: "Wait up to 300 seconds for a child Run. A wait timeout is reported honestly and does not cancel the child.",
    inputSchema: { type: "object", properties: { runId: { type: "string" }, timeoutSeconds: { type: "number", minimum: 1, maximum: 300 } }, required: ["runId", "timeoutSeconds"], additionalProperties: false },
  },
] as const;

export interface AttachResult {
  isError: boolean;
  text: string;
}

/**
 * Perform an `attach_to_chat` call by POSTing to the node's attach endpoint,
 * which confines the path to the workspace, stores the bytes, and broadcasts the
 * chip. Never throws — every failure is returned as `{ isError: true, text }` so
 * the agent gets an actionable message instead of a broken tool.
 */
export async function runAttachToChat(
  endpoint: string,
  sessionId: string,
  args: { path?: unknown; caption?: unknown },
  fetchImpl: FetchLike,
  token?: string,
): Promise<AttachResult> {
  if (!sessionId) return { isError: true, text: "No active Bivy session to attach to (BIVY_SESSION_ID is not set)." };
  const filePath = typeof args.path === "string" ? args.path.trim() : "";
  if (!filePath) return { isError: true, text: "Provide a `path` to a file inside the session workspace." };
  const caption = typeof args.caption === "string" ? args.caption : undefined;
  const base = endpoint.replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  let res: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    res = await fetchImpl(`${base}/api/session/${encodeURIComponent(sessionId)}/attach`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: filePath, caption }),
    });
  } catch (error) {
    return { isError: true, text: `Could not reach the Bivy node to attach the file: ${error instanceof Error ? error.message : String(error)}` };
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; name?: string; kind?: string };
  if (!res.ok || body?.ok === false) {
    return { isError: true, text: `Attach failed: ${body?.error || `node returned ${res.status}`}` };
  }
  const name = body?.name || filePath;
  return { isError: false, text: `Attached ${name} to the chat as ${body?.kind === "image" ? "an inline image" : "a downloadable file"}. The user can see it now.` };
}

export async function runBivyRunTool(endpoint: string, sessionId: string, name: string, args: Record<string, unknown>, fetchImpl: FetchLike, token?: string): Promise<AttachResult> {
  if (!sessionId) return { isError: true, text: "No active Bivy Session (BIVY_SESSION_ID is not set)." };
  const suffix = name === "start_run" ? "delegated-runs" : name === "get_run_status" ? `delegated-runs/${encodeURIComponent(String(args.runId ?? ""))}` : `delegated-runs/${encodeURIComponent(String(args.runId ?? ""))}/wait`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const method = name === "get_run_status" ? "GET" : "POST";
    const res = await fetchImpl(`${endpoint.replace(/\/+$/, "")}/api/session/${encodeURIComponent(sessionId)}/${suffix}`, { method, headers, ...(method === "POST" ? { body: JSON.stringify(args) } : {}) });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) return { isError: true, text: typeof body.error === "string" ? body.error : `Bivy node returned ${res.status}` };
    return { isError: false, text: JSON.stringify(body) };
  } catch (error) { return { isError: true, text: `Could not reach the Bivy node: ${error instanceof Error ? error.message : String(error)}` }; }
}

export interface McpServeDeps {
  endpoint?: string;
  sessionId?: string;
  token?: string;
  fetchImpl?: FetchLike;
}

/** Build the Bivy MCP `Server` with tools/list + tools/call handlers wired. */
export function createBivyMcpServer(deps: McpServeDeps = {}): Server {
  const endpoint = deps.endpoint ?? process.env.BIVY_MCP_ENDPOINT ?? DEFAULT_ENDPOINT;
  const sessionId = deps.sessionId ?? process.env.BIVY_SESSION_ID ?? process.env.BIVY_MCP_SESSION ?? "";
  const token = deps.token ?? process.env.BIVY_MCP_TOKEN ?? undefined;
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  const server = new Server({ name: "bivy", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: BIVY_MCP_TOOLS as unknown as never[] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const result = req.params.name === "attach_to_chat"
      ? await runAttachToChat(endpoint, sessionId, args, fetchImpl, token)
      : ["start_run", "get_run_status", "wait_for_run"].includes(req.params.name)
        ? await runBivyRunTool(endpoint, sessionId, req.params.name, args, fetchImpl, token)
        : { isError: true, text: `Unknown tool: ${req.params.name}` };
    return { isError: result.isError, content: [{ type: "text", text: result.text }] };
  });

  return server;
}

/** Connect the Bivy MCP server to stdio and serve until the stream closes. */
export async function runMcpServeCli(deps: McpServeDeps = {}): Promise<void> {
  const server = createBivyMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Resolves when the transport closes (agent disconnects / process is killed).
  await new Promise<void>((resolve) => transport.onclose = resolve);
}

// Run when invoked directly (via `bivy mcp-serve` → tsx this file). Emit nothing
// to stdout except JSON-RPC — the transport owns stdin/stdout.
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]!) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  void runMcpServeCli().catch((error) => {
    process.stderr.write(`bivy mcp-serve: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
