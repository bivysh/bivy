// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Universal Agent Harness — `bivy mcp-serve` entry point.
//
// A Bivy-OWNED stdio MCP server (the mirror of `bivy mcp-proxy`, which wraps the
// agent's OWN servers). Injected into every non-SDK agent's MCP config at session
// start (see mcp-inject.ts's injectBivyToolsForSession), it exposes Bivy's chat
// affordances as first-class tools so ANY agent — codex, gemini, aider, opencode,
// … — discovers them in its tool list instead of having to be told about a shell
// command (issue #290). It serves `attach_to_chat`, plus every tool listed in
// the `bivy` command table (bin/cli-commands.mjs, read through `bivy help
// --json`): each runs as `bivy tool <name> <json>`, i.e. the command itself with
// --json, so tools and commands share one implementation and error contract.
// The agent guides (`bivy guide`) are served as resources.
//
// Claude and Pi already get `attach_to_chat` natively (in-process SDK MCP server /
// integration ToolProvider); this covers everyone else. The tool just POSTs to the
// node's existing `POST /api/session/:id/attach` endpoint — the exact plumbing
// `bivy attach` uses — so it reuses the same workspace confinement, storage, and
// live broadcast. The session id and node URL arrive via env (BIVY_SESSION_ID /
// BIVY_MCP_ENDPOINT), stamped into the injected server spec.
//
// The attach client is factored out and unit-tested (test/harness-mcp-serve.test.ts)
// with an injected fetch; the process/transport wiring is thin. Deliberately do
// not expose governed Runs here: agents should use their native sub-agent tools,
// which stay inside the parent Session instead of cluttering the Session list.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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
        artifact: {
          type: "boolean",
          description:
            "Mark this as a named artifact — a durable output worth surfacing in the session's Artifacts list " +
            "(a report, benchmark result, coverage output, or build archive) — rather than an incidental inline image.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
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
  args: { path?: unknown; caption?: unknown; artifact?: unknown },
  fetchImpl: FetchLike,
  token?: string,
): Promise<AttachResult> {
  if (!sessionId) return { isError: true, text: "No active Bivy session to attach to (BIVY_SESSION_ID is not set)." };
  const filePath = typeof args.path === "string" ? args.path.trim() : "";
  if (!filePath) return { isError: true, text: "Provide a `path` to a file inside the session workspace." };
  const caption = typeof args.caption === "string" ? args.caption : undefined;
  const artifact = args.artifact === true;
  const base = endpoint.replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  let res: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    res = await fetchImpl(`${base}/api/session/${encodeURIComponent(sessionId)}/attach`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: filePath, caption, ...(artifact ? { artifact } : {}) }),
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

/** One `bivy` CLI run: its exit code and output. */
export interface CliResult { code: number; stdout: string; stderr: string }
export type RunBivy = (args: string[]) => Promise<CliResult>;

/** Run this install's `bivy` (bin/bivy.mjs, two levels up from src/ or dist/). */
function defaultRunBivy(sessionId: string): RunBivy {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/bivy.mjs");
  return (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, BIVY_SESSION_ID: sessionId, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: stderr || error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

interface CliTool { name: string; description: string; inputSchema: Record<string, unknown> }

/** The tools the command table offers, or none when the CLI can't be asked. */
async function cliTools(runBivy: RunBivy): Promise<CliTool[]> {
  const result = await runBivy(["help", "--json"]);
  try {
    const tools = (JSON.parse(result.stdout) as { tools?: CliTool[] }).tools ?? [];
    return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  } catch {
    return [];
  }
}

export interface McpServeDeps {
  /** Runs `bivy` with these args; defaults to this install's CLI. */
  runBivy?: RunBivy;
  endpoint?: string;
  sessionId?: string;
  token?: string;
  fetchImpl?: FetchLike;
  /** Composed account-wide instructions file (BIVY_AGENT_INSTRUCTIONS_FILE). */
  instructionsFile?: string;
}

/** The user's instructions to advertise at initialize, or undefined when there are none. */
function readInstructions(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    return fs.readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Build the Bivy MCP `Server` with tools/list + tools/call handlers wired. */
export function createBivyMcpServer(deps: McpServeDeps = {}): Server {
  const endpoint = deps.endpoint ?? process.env.BIVY_MCP_ENDPOINT ?? DEFAULT_ENDPOINT;
  const sessionId = deps.sessionId ?? process.env.BIVY_SESSION_ID ?? process.env.BIVY_MCP_SESSION ?? "";
  const token = deps.token ?? process.env.BIVY_MCP_TOKEN ?? undefined;
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  const instructions = readInstructions(deps.instructionsFile ?? process.env.BIVY_AGENT_INSTRUCTIONS_FILE);

  const runBivy = deps.runBivy ?? defaultRunBivy(sessionId);
  let tools: Promise<CliTool[]> | undefined;
  const generated = () => (tools ??= cliTools(runBivy));

  const server = new Server({ name: "bivy", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} }, ...(instructions ? { instructions } : {}) });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...BIVY_MCP_TOOLS, ...await generated()] as unknown as never[] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (req.params.name === "attach_to_chat") {
      const result = await runAttachToChat(endpoint, sessionId, args, fetchImpl, token);
      return { isError: result.isError, content: [{ type: "text", text: result.text }] };
    }
    if (!(await generated()).some((tool) => tool.name === req.params.name)) {
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }] };
    }
    const result = await runBivy(["tool", req.params.name, JSON.stringify(args)]);
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || (result.code === 0 ? "Done." : `bivy exited ${result.code}.`);
    return { isError: result.code !== 0, content: [{ type: "text", text }] };
  });

  // The agent guides, one resource per topic.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const result = await runBivy(["guide", "--json"]);
    const guides = (() => { try { return (JSON.parse(result.stdout) as { guides: { topic: string; title: string; summary: string }[] }).guides; } catch { return []; } })();
    return { resources: guides.map((g) => ({ uri: `bivy://guide/${g.topic}`, name: g.title, description: g.summary, mimeType: "text/markdown" })) };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const topic = /^bivy:\/\/guide\/([a-z0-9-]+)$/.exec(req.params.uri)?.[1];
    const result = topic ? await runBivy(["guide", topic, "--json"]) : undefined;
    const guide = (() => { try { return result && result.code === 0 ? (JSON.parse(result.stdout) as { markdown: string }) : undefined; } catch { return undefined; } })();
    if (!guide) throw new Error(`No Bivy resource at ${req.params.uri}`);
    return { contents: [{ uri: req.params.uri, mimeType: "text/markdown", text: guide.markdown }] };
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
