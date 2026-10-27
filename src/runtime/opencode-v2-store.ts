// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// OpenCode 2 session store.
//
// OpenCode 2 replaced the `session`/`message`/`part` tables with `session_v2`
// (one row per session) and `session_message` (one row per message, typed
// `user` / `assistant` / `idle` / …, its body in `data`). Bivy reads those two
// tables read-only, and writes only through OpenCode's own CLI
// (`opencode session import|delete --standalone`), whose JSON document is the
// documented `opencode session export` format: `{ info, messages }`, each
// message being its row's `data` plus `id` and `type`. `--standalone` runs a
// private server for the one command instead of starting OpenCode's
// background service. Verified against OpenCode 2.1.4.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ForkHistoryMessage, ForkImportContext, ForkNativePayload, RuntimeMessage } from "./types.js";

type Db = { prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } };
type MessageRow = { id: string; type: string; time_created: number; data: string };
type Message = { id: string; type: string; [key: string]: unknown };
export type OpenCodeV2Document = { info: Record<string, unknown> & { id: string }; messages: Message[] };

export const OPENCODE_V2_PAYLOAD = "opencode-v2";
const CLI_TIMEOUT_MS = 60_000;
const NO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

export function isOpenCodeV2Store(db: Db): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_v2'").get());
}

function freshId(prefix: string): string {
  return `${prefix}${randomBytes(12).toString("hex")}`;
}

function parse(data: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(data) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function messageRows(db: Db, sessionRef: string): MessageRow[] {
  return db.prepare("SELECT id, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq, id").all(sessionRef) as MessageRow[];
}

/** The text a user or assistant message shows; empty for every other type. */
function messageText(type: string, data: Record<string, unknown>): string {
  if (type === "user") return typeof data.text === "string" ? data.text : "";
  if (type !== "assistant" || !Array.isArray(data.content)) return "";
  return data.content
    .map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
    .join("");
}

export function loadOpenCodeV2Transcript(db: Db, sessionRef: string): RuntimeMessage[] {
  const messages: RuntimeMessage[] = [];
  for (const row of messageRows(db, sessionRef)) {
    const data = parse(row.data);
    const content = data ? messageText(row.type, data) : "";
    if (content) messages.push({ role: row.type as "user" | "assistant", content, timestamp: row.time_created });
  }
  return messages;
}

export function discoverOpenCodeV2Session(db: Db, cwd: string, since: number): { id: string } | undefined {
  const row = db
    .prepare("SELECT id FROM session_v2 WHERE directory = ? AND parent_id IS NULL AND time_created >= ? ORDER BY time_created ASC, id LIMIT 1")
    .get(path.resolve(cwd), since) as { id?: string } | undefined;
  return row?.id ? { id: row.id } : undefined;
}

/** A session as the `opencode session export` document, for a same-agent fork. */
export function exportOpenCodeV2Session(db: Db, sessionRef: string): ForkNativePayload | undefined {
  const session = db.prepare("SELECT * FROM session_v2 WHERE id = ?").get(sessionRef) as Record<string, unknown> | undefined;
  if (!session) return undefined;
  const messages = messageRows(db, sessionRef).flatMap((row) => {
    const data = parse(row.data);
    return data ? [{ ...data, id: row.id, type: row.type }] : [];
  });
  const info = {
    id: sessionRef,
    projectID: String(session.project_id ?? "global"),
    cost: Number(session.cost) || 0,
    tokens: {
      input: Number(session.tokens_input) || 0,
      output: Number(session.tokens_output) || 0,
      reasoning: Number(session.tokens_reasoning) || 0,
      cache: { read: Number(session.tokens_cache_read) || 0, write: Number(session.tokens_cache_write) || 0 },
    },
    time: { created: Number(session.time_created), updated: Number(session.time_updated) },
    location: { directory: String(session.directory) },
    ...(typeof session.title === "string" && session.title ? { title: session.title } : {}),
  };
  const document: OpenCodeV2Document = { info, messages };
  return { runtimeId: "opencode", kind: OPENCODE_V2_PAYLOAD, data: document };
}

/** The exported document re-keyed as a new session in `ctx.cwd`. */
export function forkOpenCodeV2Document(payload: ForkNativePayload, ctx: ForkImportContext): OpenCodeV2Document {
  const source = payload.data as OpenCodeV2Document | undefined;
  if (payload.kind !== OPENCODE_V2_PAYLOAD || !source?.info || !Array.isArray(source.messages)) {
    throw new Error(`Unexpected OpenCode fork payload kind: ${payload.kind}`);
  }
  const model = ctx.model?.id ? { id: ctx.model.id, providerID: ctx.model.provider } : undefined;
  const messages = source.messages.map((message) => ({
    ...message,
    id: freshId("msg_"),
    ...(model && message.type === "assistant" ? { model } : {}),
  }));
  return { info: { ...source.info, id: freshId("ses_"), location: { directory: ctx.cwd } }, messages };
}

/** A cross-agent fork's portable history as a new OpenCode session. */
export function openCodeV2DocumentFromHistory(history: ForkHistoryMessage[], ctx: ForkImportContext): OpenCodeV2Document {
  const model = ctx.model?.id
    ? { id: ctx.model.id, providerID: ctx.model.provider || "opencode" }
    : { id: "big-pickle", providerID: "opencode" };
  const start = Date.now() - history.length;
  const messages = history.map((turn, index): Message => {
    const time = start + index;
    return turn.role === "user"
      ? { id: freshId("msg_"), type: "user", time: { created: time }, text: turn.text }
      : { id: freshId("msg_"), type: "assistant", time: { created: time, completed: time }, agent: "build", model, content: [{ type: "text", text: turn.text }], finish: "stop" };
  });
  return {
    info: { id: freshId("ses_"), projectID: "global", title: "Forked session", cost: 0, tokens: NO_TOKENS, time: { created: start, updated: start + history.length }, location: { directory: ctx.cwd } },
    messages,
  };
}

function runOpenCode(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("opencode", [...args, "--standalone"], { timeout: CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`opencode ${args[0]} ${args[1]} failed: ${String(stderr || error.message).trim().split("\n")[0]}`));
      else resolve(stdout);
    });
  });
}

export async function importOpenCodeV2Document(document: OpenCodeV2Document): Promise<{ sessionFile: string; id: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-opencode-"));
  const file = path.join(dir, "session.json");
  try {
    fs.writeFileSync(file, JSON.stringify(document), { mode: 0o600 });
    const directory = String((document.info.location as { directory?: unknown } | undefined)?.directory ?? process.cwd());
    await runOpenCode(["session", "import", "--directory", directory, file]);
    return { sessionFile: document.info.id, id: document.info.id };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function deleteOpenCodeV2Session(sessionRef: string): Promise<boolean> {
  return runOpenCode(["session", "delete", sessionRef]).then(() => true, () => false);
}
