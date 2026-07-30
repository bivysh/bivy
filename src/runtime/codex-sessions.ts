// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Codex on-disk session ("rollout") reader — the read side of adopting a Codex
// session that was started outside Bivy (e.g. a bare `codex` in a terminal).
//
// The Codex CLI ("@openai/codex") persists each session as a JSONL rollout under
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
// (CODEX_HOME defaults to ~/.codex). The first line carries session metadata
// (id, cwd, timestamp); subsequent lines are response/event items.
//
// IMPORTANT — best-effort, and NOT yet verified against a live Codex here:
// Codex's rollout record shape has changed across versions, so every read is
// defensive (unknown/malformed lines are skipped, never thrown), and both a
// wrapped (`{type,payload}`) and a flat record layout are tolerated. This module
// only *reconstructs history* and *locates* sessions; a governed live resume of a
// Codex session additionally needs the Codex runtime to gain resume +
// toolInterception (today it is a non-governing process runtime — see
// docs/agent-runtimes.md and src/runtime/index.ts `cliAgentInfo`). Unlike Claude,
// Codex has no stable launch-time session-id flag to pin, so adoption relies on
// locating the rollout a run produced (see discoverCodexSessionForCwd).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hasLiveProcessForCwd } from "./native-process-scan.js";
import type { DiscoveredNativeSession, ForkHistoryMessage, RuntimeMessage } from "./types.js";

/** Binary names a live Codex process could be running under (see
 *  native-process-scan.ts's best-effort cwd match). */
const CODEX_BIN_NAMES = ["codex"];

export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

export function codexSessionsDir(): string {
  return path.join(codexHome(), "sessions");
}

export interface CodexSessionSummary {
  /** Codex session id (UUID) when the rollout meta carried one. */
  id?: string;
  /** Absolute path of the rollout file. */
  file: string;
  /** Working directory the session ran in, when recorded. */
  cwd?: string;
  /** Epoch ms of the session start, from meta or the file mtime. */
  createdAt?: number;
  /** First user prompt, truncated — a readable list label. */
  firstMessage?: string;
}

/** Unwrap a `{ type, payload }` envelope, else return the record as-is. */
function inner(rec: unknown): Record<string, unknown> {
  const r = (rec ?? {}) as Record<string, unknown>;
  return r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : r;
}

function toEpoch(value: unknown): number | undefined {
  if (value == null) return undefined;
  const ms = new Date(value as string | number).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/** Recursively collect `rollout-*.jsonl` files under a Codex sessions dir. */
function findRolloutFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // missing/unreadable — best-effort
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Session metadata from a rollout's first line (id / cwd / start time). */
function metaFromFirstLine(line: string): { id?: string; cwd?: string; createdAt?: number } {
  try {
    const rec = JSON.parse(line) as Record<string, unknown>;
    const p = inner(rec);
    const id = typeof p.id === "string" ? p.id : typeof p.session_id === "string" ? (p.session_id as string) : undefined;
    const cwd = typeof p.cwd === "string" ? (p.cwd as string) : undefined;
    const createdAt = toEpoch(p.timestamp ?? rec.timestamp);
    return { id, cwd, createdAt };
  } catch {
    return {};
  }
}

/** Extract plain text from a Codex content field (string or content-block array). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = (block ?? {}) as Record<string, unknown>;
      if (typeof b.text === "string") return b.text;
      return "";
    })
    .join("")
    .trim();
}

/**
 * Reconstruct a session's conversation from its rollout file as normalized
 * RuntimeMessages (role + content + timestamp) — the same shape loadClaudeTranscript
 * produces, so a reopened Codex session paints prior history the same way. Skips
 * meta/system/tooling records; keeps user and assistant turns. Best-effort.
 */
export function loadCodexTranscriptFile(file: string): RuntimeMessage[] {
  const messages: RuntimeMessage[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return messages;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const p = inner(rec);
    // A message item: either {role, content} directly or an item with type "message".
    const role = p.role ?? (p.type === "message" ? (p as Record<string, unknown>).role : undefined);
    if (role !== "user" && role !== "assistant") continue;
    const content = p.content ?? p.text;
    const text = textOf(content);
    if (!text) continue;
    messages.push({ role, content: text, timestamp: toEpoch(p.timestamp ?? rec.timestamp) ?? Date.now() });
  }
  return messages;
}

/**
 * Materialise a **cross-runtime** fork's portable history as a fresh Codex
 * rollout so `codex ... resume <id>` (the app-server's `thread/resume`) opens on
 * a copy of the whole conversation — the write-side counterpart to
 * `loadCodexTranscript`, and Codex's `importHistoryForFork` (fidelity
 * "replayed"). The rollout is written in the current wrapped layout — a
 * `session_meta` line then one `response_item` per turn — under the id-addressed
 * date path Codex uses (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`), the
 * same shape `loadCodexTranscriptFile` reads back and `discoverCodexSessionForCwd`
 * locates. Message turns carry a Responses-API `message` item (`input_text` for
 * the user, `output_text` for the assistant), which reads back through `textOf`.
 *
 * IMPORTANT — best-effort, and NOT verified against a live Codex resume here (see
 * this module's header): Codex's rollout schema is version-variable, so whether a
 * *synthesised* rollout is fully honored by `thread/resume` depends on the
 * installed Codex. The fork engine calls this only as its "replayed" tier and
 * falls back to a seeded continuation prompt if it throws; a node can force that
 * fallback outright with `BIVY_CODEX_NO_FORK_REPLAY=1` when its Codex build
 * doesn't accept synthesised rollouts.
 */
export function writeCodexRollout(
  history: ForkHistoryMessage[],
  cwd: string,
): { sessionFile: string; id: string } {
  if (process.env.BIVY_CODEX_NO_FORK_REPLAY === "1") {
    throw new Error("Codex fork replay disabled (BIVY_CODEX_NO_FORK_REPLAY=1)");
  }
  const id = randomUUID();
  const now = new Date();
  const iso = now.toISOString();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const dir = path.join(codexSessionsDir(), yyyy, mm, dd);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = iso.replace(/[:.]/g, "-").replace(/Z$/, "");
  const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  const records: unknown[] = [
    { type: "session_meta", timestamp: iso, payload: { id, timestamp: iso, cwd, cli_version: "bivy-fork" } },
    ...history.map((message) => ({
      type: "response_item",
      timestamp: iso,
      payload: {
        type: "message",
        role: message.role,
        content: [{ type: message.role === "user" ? "input_text" : "output_text", text: message.text }],
      },
    })),
  ];
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { sessionFile: id, id };
}

/** Enumerate Codex sessions on disk, newest first. Best-effort. */
export function listCodexSessions(): CodexSessionSummary[] {
  const sessions: CodexSessionSummary[] = [];
  for (const file of findRolloutFiles(codexSessionsDir())) {
    let firstLine = "";
    let mtime: number | undefined;
    try {
      mtime = fs.statSync(file).mtimeMs;
      const fd = fs.readFileSync(file, "utf8");
      firstLine = fd.split(/\r?\n/, 1)[0] ?? "";
    } catch {
      continue;
    }
    const meta = metaFromFirstLine(firstLine);
    const transcript = loadCodexTranscriptFile(file);
    // Codex prepends synthetic context turns as the first "user" messages —
    // `<environment_context>`, `<recommended_plugins>`, `<user_instructions>`,
    // etc. — which make useless list labels. Prefer the first turn that isn't one
    // of these XML-ish blocks (i.e. the user's real prompt), falling back to the
    // first turn only if that's genuinely all there is.
    const userTurns = transcript.filter((m) => (m as { role?: string }).role === "user");
    const contentOf = (m: unknown) => String((m as { content?: unknown })?.content ?? "");
    const isInjectedBlock = (text: string) => /^<[a-z][\w-]*>/i.test(text.trimStart());
    const firstUser = userTurns.find((m) => !isInjectedBlock(contentOf(m))) ?? userTurns[0];
    const firstMessage = firstUser ? contentOf(firstUser).slice(0, 200) : undefined;
    sessions.push({
      id: meta.id,
      file,
      cwd: meta.cwd,
      createdAt: meta.createdAt ?? mtime,
      firstMessage,
    });
  }
  return sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** Load a Codex session's transcript by its session id (searches the store). */
export function loadCodexTranscript(sessionId: string): RuntimeMessage[] {
  const match = listCodexSessions().find((s) => s.id === sessionId);
  return match ? loadCodexTranscriptFile(match.file) : [];
}

/**
 * Delete a Codex session's rollout file by id so a user-initiated delete in the
 * app actually removes it from Codex's store (`$CODEX_HOME/sessions/**`) — the
 * read-side counterpart to loadCodexTranscript. Returns true if a rollout was
 * unlinked. Best-effort: a missing store / already-gone file is not an error.
 */
export function deleteCodexSession(sessionId: string): boolean {
  const match = listCodexSessions().find((s) => s.id === sessionId);
  if (!match) return false;
  try {
    fs.unlinkSync(match.file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Locate the Codex session a run produced, for adoption when there is no pinned
 * id: the newest rollout whose recorded cwd matches `cwd` and that started at/after
 * `since` (the run-terminal's creation time, minus a small skew). Returns the
 * session summary or undefined. Best-effort — Codex assigns the id itself, so this
 * is how a `bivy run codex` session is mapped back to its on-disk rollout.
 */
export function discoverCodexSessionForCwd(cwd: string, since = 0): CodexSessionSummary | undefined {
  const target = path.resolve(cwd);
  const skewMs = 5_000;
  return listCodexSessions().find(
    (s) => s.cwd != null && path.resolve(s.cwd) === target && (s.createdAt ?? 0) >= since - skewMs,
  );
}

/**
 * Enumerate Codex's on-disk sessions as bounded discovery metadata (issue
 * #156's runtime-agnostic discovery/adoption flow — see
 * native-session-discovery.ts). Every Codex session Codex itself assigned an
 * id to is resumable via `codex exec resume <id>`, so `resumable` is true
 * whenever an id was recorded; `active` is a best-effort live-process check
 * scoped to this session's own cwd, never its transcript content.
 */
export function discoverNativeCodexSessions(
  hasLiveProcess: (cwd: string) => boolean = (cwd) => hasLiveProcessForCwd(cwd, CODEX_BIN_NAMES),
): DiscoveredNativeSession[] {
  return listCodexSessions()
    .filter((s): s is CodexSessionSummary & { id: string } => Boolean(s.id))
    .map((s) => ({
      runtimeId: "codex-approvals",
      ref: s.id,
      file: s.file,
      cwd: s.cwd,
      updatedAt: s.createdAt,
      title: s.firstMessage,
      active: Boolean(s.cwd) && hasLiveProcess(s.cwd!),
      resumable: true,
    }));
}
