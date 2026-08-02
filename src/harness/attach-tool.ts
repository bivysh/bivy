// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// The `attach_to_chat` tool — the first-class, runtime-agnostic half of the
// outbound-attachment feature (issue #290: make `bivy attach` discoverable to
// EVERY agent, not just Claude via a system-prompt sentence).
//
// `bivy attach` is a shell command: an agent has to be *told* it exists or it
// concludes it can't send a file and describes a path the chat can't load. A
// prose hint in the system prompt is weak — models reach for tools. This exposes
// the same capability as a real tool so it shows up in the agent's tool list.
//
// This module is the shared, transport-free core: the tool's name/description/
// input schema and a `runAttachTool` that performs the attach by POSTing to the
// node's existing `POST /api/session/:id/attach` endpoint (the exact plumbing
// `bivy attach` uses — see bin/bivy.mjs cmdAttach and src/server.ts). Consumers:
//   - Claude Code registers it as an in-process SDK MCP server (claude-code.ts),
//     so it rides every query — including a resume, where a changed system prompt
//     would not re-apply.
//   - A `bivy mcp-serve` stdio server (follow-up) injects it into other agents'
//     MCP configs.
// Keeping the HTTP call here means neither consumer re-implements confinement,
// storage, or the live broadcast — the server side already owns all of that.

import { z } from "zod";

/** Loopback default matching the daemon's own BIVY_MCP_ENDPOINT fallback. */
export const DEFAULT_ATTACH_ENDPOINT = "http://127.0.0.1:4317";

export const ATTACH_TOOL_NAME = "attach_to_chat";

export const ATTACH_TOOL_DESCRIPTION =
  "Send a file or image from the session workspace into the chat the user is reading. " +
  "The person you're talking to is in a chat UI: they cannot see files you only write to disk, and the chat cannot " +
  "load workspace paths or remote image URLs. Use this to show them a report, screenshot, chart, or any file they " +
  "asked for. An image renders inline; any other file shows as a downloadable chip. The path must be inside the " +
  "session workspace. Prefer this over pasting large file contents, describing where a file lives, or using markdown " +
  "image syntax (which will not render).";

/** Zod raw shape for the SDK `tool()` helper and MCP input validation. */
export const attachToolInputShape = {
  path: z.string().describe("Path to the file to send, inside the session workspace (absolute, or relative to the workspace)."),
  caption: z.string().optional().describe("Optional short note shown with the attachment."),
};

export const attachToolInputSchema = z.object(attachToolInputShape);
export type AttachToolInput = z.infer<typeof attachToolInputSchema>;

export interface RunAttachToolOptions {
  /** Base URL of the local node, e.g. http://127.0.0.1:4317. */
  endpoint: string;
  /** The session to attach to (BIVY_SESSION_ID). */
  sessionId: string;
  path: string;
  caption?: string;
  /** Optional bearer token for multi-user hosts (loopback bypasses auth). */
  token?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Result the caller turns into an MCP `CallToolResult`. `text` is safe to show
 *  to the agent verbatim; `isError` marks a failed/blocked attach. */
export interface AttachToolResult {
  isError: boolean;
  text: string;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Perform an `attach_to_chat` call: POST the path to the node's attach endpoint,
 * which confines it to the workspace, stores the bytes, and broadcasts the chip.
 * Never throws — every failure comes back as `{ isError: true, text }` so the
 * agent gets an actionable message instead of a crashed tool.
 */
export async function runAttachTool(opts: RunAttachToolOptions): Promise<AttachToolResult> {
  const sessionId = String(opts.sessionId ?? "").trim();
  if (!sessionId) {
    return { isError: true, text: "No active Bivy session to attach to (BIVY_SESSION_ID is not set)." };
  }
  const filePath = String(opts.path ?? "").trim();
  if (!filePath) {
    return { isError: true, text: "Provide a `path` to a file inside the session workspace." };
  }
  const base = (opts.endpoint || DEFAULT_ATTACH_ENDPOINT).replace(/\/+$/, "");
  const url = `${base}/api/session/${encodeURIComponent(sessionId)}/attach`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const fetchImpl = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: filePath, caption: opts.caption }),
    });
  } catch (error) {
    return { isError: true, text: `Could not reach the Bivy node to attach the file: ${errText(error)}` };
  }

  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; name?: string; kind?: string };
  if (!res.ok || body?.ok === false) {
    return { isError: true, text: `Attach failed: ${body?.error || `node returned ${res.status}`}` };
  }
  const name = body?.name || filePath;
  const asImage = body?.kind === "image";
  return {
    isError: false,
    text: `Attached ${name} to the chat as ${asImage ? "an inline image" : "a downloadable file"}. The user can see it now.`,
  };
}
