// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Grok CLI on-disk session reader — the read side of adopting a Grok session
// started outside governed chat (e.g. `bivy run grok` or a bare `grok` TUI).
//
// Layout (official Grok CLI 1.x):
//   $GROK_HOME/sessions/<url-encoded-cwd>/<session-uuid>/
//     summary.json          — id, cwd, title, timestamps, model
//     chat_history.jsonl    — user / assistant / system / tool_result lines
//
// GROK_HOME defaults to ~/.grok (see grok-auth.ts's resolveGrokHome). Every read
// is best-effort: a missing/malformed store never throws out of the list path.

import fs from "node:fs";
import path from "node:path";
import { resolveGrokHome } from "./grok-auth.js";
import { hasLiveProcessForCwd } from "./native-process-scan.js";
import type { DiscoveredNativeSession, RuntimeMessage } from "./types.js";

const GROK_BIN_NAMES = ["grok"];

export function grokSessionsRoot(): string {
  return path.join(resolveGrokHome(), "sessions");
}

export interface GrokSessionSummary {
  /** Grok session UUID (also the on-disk directory name). */
  id: string;
  /** Absolute path of the session directory. */
  dir: string;
  /** Working directory the session ran in, when recorded. */
  cwd?: string;
  /** Epoch ms of session start (from summary or dir mtime). */
  createdAt?: number;
  /** Epoch ms of last activity. */
  updatedAt?: number;
  /** Generated / user title, when present. */
  name?: string;
  /** First user-visible prompt, truncated — a readable list label. */
  firstMessage?: string;
}

function toEpoch(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const ms = new Date(value as string | number).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function readSummary(dir: string): Partial<GrokSessionSummary> | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8")) as Record<string, unknown>;
    const info = (raw.info && typeof raw.info === "object" ? raw.info : {}) as Record<string, unknown>;
    const id = typeof info.id === "string" ? info.id : path.basename(dir);
    const cwd = typeof info.cwd === "string" ? info.cwd : undefined;
    const name =
      (typeof raw.generated_title === "string" && raw.generated_title.trim()) ||
      (typeof raw.session_summary === "string" && raw.session_summary.trim()) ||
      undefined;
    return {
      id,
      dir,
      cwd,
      createdAt: toEpoch(raw.created_at),
      updatedAt: toEpoch(raw.last_active_at ?? raw.updated_at),
      name,
    };
  } catch {
    return undefined;
  }
}

/** Pull plain text out of a Grok content field (string or content-block array). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/** First user-visible prompt that isn't a system/meta wrapper. */
function firstUserMessage(dir: string): string | undefined {
  const file = path.join(dir, "chat_history.jsonl");
  let fh: number | undefined;
  try {
    fh = fs.openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fh, buf, 0, buf.length, 0);
    const chunk = buf.subarray(0, n).toString("utf8");
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (rec.type !== "user") continue;
      const text = contentText(rec.content).trim();
      if (!text) continue;
      // Skip the CLI's environment / system-reminder scaffolding — the first
      // real user_query (or a short free-form prompt) is the list label.
      const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i)?.[1]?.trim();
      const label = (query || text).replace(/\s+/g, " ").trim();
      if (!label) continue;
      // Skip pure meta blobs that never carry a user question.
      if (label.startsWith("<user_info>") || label.startsWith("<system-reminder>") || label.startsWith("<git_status>")) {
        continue;
      }
      return label.length > 120 ? `${label.slice(0, 119)}…` : label;
    }
  } catch {
    return undefined;
  } finally {
    if (fh !== undefined) try { fs.closeSync(fh); } catch { /* ignore */ }
  }
  return undefined;
}

/**
 * Enumerate Grok sessions under $GROK_HOME/sessions. Best-effort: a missing or
 * unreadable store returns []. Sorted newest-activity-first.
 */
export function listGrokSessions(): GrokSessionSummary[] {
  const root = grokSessionsRoot();
  let cwdEntries: fs.Dirent[];
  try {
    cwdEntries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: GrokSessionSummary[] = [];
  for (const cwdEntry of cwdEntries) {
    if (!cwdEntry.isDirectory()) continue;
    // Skip the search index / non-session dirs.
    if (cwdEntry.name === "session_search.sqlite" || cwdEntry.name.endsWith(".sqlite")) continue;
    const cwdDir = path.join(root, cwdEntry.name);
    let sessionEntries: fs.Dirent[];
    try {
      sessionEntries = fs.readdirSync(cwdDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const dir = path.join(cwdDir, sessionEntry.name);
      const summary = readSummary(dir);
      if (!summary?.id) continue;
      // Prefer the cwd encoded in the parent dir name when summary lacks one.
      let cwd = summary.cwd;
      if (!cwd) {
        try {
          cwd = decodeURIComponent(cwdEntry.name);
        } catch {
          cwd = undefined;
        }
      }
      let createdAt = summary.createdAt;
      let updatedAt = summary.updatedAt;
      if (createdAt == null || updatedAt == null) {
        try {
          const st = fs.statSync(dir);
          createdAt = createdAt ?? (st.birthtimeMs || st.mtimeMs);
          updatedAt = updatedAt ?? st.mtimeMs;
        } catch {
          /* ignore */
        }
      }
      out.push({
        id: summary.id,
        dir,
        cwd,
        createdAt,
        updatedAt,
        name: summary.name,
        firstMessage: firstUserMessage(dir),
      });
    }
  }
  return out.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
}

/**
 * Load a Grok session's chat_history.jsonl as RuntimeMessage[] for history
 * preload when a governed chat resumes that session. System scaffolding and
 * tool_result rows are dropped — the chat surface only needs the user/assistant
 * turns. Best-effort; a missing/malformed file returns [].
 */
export function loadGrokTranscript(sessionId: string): RuntimeMessage[] {
  const match = listGrokSessions().find((s) => s.id === sessionId);
  if (!match) return [];
  const file = path.join(match.dir, "chat_history.jsonl");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: RuntimeMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = rec.type;
    if (type !== "user" && type !== "assistant") continue;
    let text = contentText(rec.content).trim();
    if (!text) continue;
    // Prefer the inner <user_query> when the CLI wrapped the prompt.
    if (type === "user") {
      const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i)?.[1]?.trim();
      if (query) text = query;
      // Skip pure meta system blobs that aren't real user turns.
      if (
        text.startsWith("<user_info>") ||
        text.startsWith("<system-reminder>") ||
        text.startsWith("<git_status>") ||
        text.startsWith("<image_files>") ||
        text.startsWith("<action_safety>")
      ) {
        continue;
      }
    }
    out.push({
      role: type === "user" ? "user" : "assistant",
      content: text,
      timestamp: typeof rec.timestamp === "string" || typeof rec.timestamp === "number" ? toEpoch(rec.timestamp) : undefined,
    } as RuntimeMessage);
  }
  return out;
}

/**
 * Locate the Grok session a run produced (by cwd + start time) when there is no
 * launch-time pinned id. Mirrors discoverCodexSessionForCwd / discoverPiSessionForCwd.
 */
export function discoverGrokSessionForCwd(cwd: string, since = 0): GrokSessionSummary | undefined {
  const target = path.resolve(cwd);
  const skewMs = 10_000;
  const earliest = since - skewMs;
  const wanted = process.platform === "win32" ? target.toLowerCase() : target;
  return listGrokSessions()
    .filter((s) => {
      if (!s.cwd) return false;
      const resolved = process.platform === "win32" ? path.resolve(s.cwd).toLowerCase() : path.resolve(s.cwd);
      return resolved === wanted;
    })
    .filter((s) => (s.createdAt ?? 0) >= earliest)
    .sort((a, b) => {
      const da = Math.abs((a.createdAt ?? 0) - since);
      const db = Math.abs((b.createdAt ?? 0) - since);
      if (da !== db) return da - db;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    })[0];
}

/** Issue #156 discovery surface for Grok's on-disk store. */
export function discoverNativeGrokSessions(
  hasLiveProcess: (cwd: string) => boolean = (cwd) => hasLiveProcessForCwd(cwd, GROK_BIN_NAMES),
): DiscoveredNativeSession[] {
  return listGrokSessions().map((s) => ({
    runtimeId: "grok",
    ref: s.id,
    file: s.dir,
    cwd: s.cwd,
    updatedAt: s.updatedAt ?? s.createdAt,
    title: s.name || s.firstMessage,
    active: Boolean(s.cwd) && hasLiveProcess(s.cwd!),
    resumable: true,
  }));
}
