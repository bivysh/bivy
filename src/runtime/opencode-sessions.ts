// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// OpenCode on-disk session store — the write/read side of materialising a
// **cross-runtime** fork as a real session in OpenCode's own store (fidelity
// "replayed"), the same role codex-sessions.ts plays for Codex.
//
// OpenCode (opencode-ai) persists every session in SQLite at
//   $XDG_DATA_HOME/opencode/opencode.db        (XDG_DATA_HOME → ~/.local/share)
// in three tables that are the source of truth for a conversation:
//   - `session`  one row per session (id, slug, title, project_id, model, times)
//   - `message`  one row per turn (data is JSON: role + model + time)
//   - `part`     one row per content block (data is JSON: `{type:"text",text}`)
// The `event`/`event_sequence` tables are OpenCode's event-sourcing log for live
// sync/streaming; Bivy's governed path (`opencode acp` via bin/acp-shim.mjs)
// loads a session purely from `session`/`message`/`part` — `session/load` and
// `session/prompt` resume a hand-written session and replay the full transcript
// to the model — and `opencode session list` / `opencode export` read the same
// snapshot, so those three rows are all a replay fork needs.
//
// IMPORTANT — best-effort, verified against opencode 1.18.23 (the version
// pin in AGENT_PROFILES): the schema is version-variable, so the writer checks
// for the `session`/`message`/`part` tables and throws (never corrupts) when a
// node's OpenCode layout doesn't match. The fork engine calls this only as its
// "replayed" tier and falls back to a seeded continuation prompt if it throws;
// a node can force that fallback outright with `BIVY_OPENCODE_NO_FORK_REPLAY=1`.
// Uses node:sqlite (Node ≥22.19 per engines) — no external dependency.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ForkHistoryMessage, ForkImportContext, ForkNativePayload, RuntimeMessage } from "./types.js";

/** Fallback when the DB has no session row to learn the running version from. */
const FALLBACK_VERSION = "1.18.23";

/** The project every OpenCode install seeds; used for fork sessions so no
 *  per-directory project row has to be synthesised. */
const GLOBAL_PROJECT_ID = "global";

/** The model recorded on real OpenCode sessions when none is requested. */
const DEFAULT_MODEL_ID = "big-pickle";
const DEFAULT_MODEL_PROVIDER = "opencode";

/** OpenCode's data dir: $XDG_DATA_HOME/opencode (XDG_DATA_HOME → ~/.local/share). */
export function opencodeDataDir(): string {
  const base = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(base, "opencode");
}

export function opencodeDbPath(): string {
  return path.join(opencodeDataDir(), "opencode.db");
}

/** A cuid2-style id (`ses_<24 hex>`) like OpenCode's own ids. */
function openCodeId(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Open the node's OpenCode SQLite store read-write. Throws when the store
 * doesn't exist or lacks the conversation tables (OpenCode never run, or a
 * version/schema we don't know) — the caller must treat this as "no replay".
 */
function openOpenCodeDb(readWrite: boolean): DatabaseSync {
  const file = opencodeDbPath();
  const present = (() => {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  })();
  if (!present) throw new Error(`OpenCode store not found at ${file} (run OpenCode once to create it)`);
  const db = readWrite ? new DatabaseSync(file) : new DatabaseSync(file, { readOnly: true });
  if (readWrite) {
    // Cascade deletes (message/part/event rows under a session) need FK enforcement.
    db.exec("PRAGMA foreign_keys = ON");
    // OpenCode runs in WAL mode; a briefly-held writer (a live TUI/server) would
    // otherwise reject the insert instantly instead of waiting a moment.
    db.exec("PRAGMA busy_timeout = 5000");
  }
  for (const table of ["session", "message", "part"]) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!row) {
      db.close();
      throw new Error(`OpenCode store at ${file} is missing the "${table}" table; fork replay requires a compatible OpenCode layout`);
    }
  }
  return db;
}

/** The OpenCode version string to stamp on a fork session — learn it from the
 *  newest session in the store (matches the installed binary), else a fallback. */
function openCodeVersion(db: DatabaseSync): string {
  const row = db.prepare("SELECT version FROM session ORDER BY time_created DESC, id LIMIT 1").get() as { version?: string | null } | undefined;
  return (row?.version && row.version.trim()) || FALLBACK_VERSION;
}

/** Resolve the model to stamp on the fork session from the fork context. */
function resolveModel(ctx: ForkImportContext): { modelID: string; providerID: string } {
  const requested = ctx.model?.id?.trim();
  if (requested) {
    return {
      modelID: requested,
      providerID: ctx.model?.provider?.trim() || (requested.includes("/") ? requested.split("/")[0]! : "opencode"),
    };
  }
  return { modelID: DEFAULT_MODEL_ID, providerID: DEFAULT_MODEL_PROVIDER };
}

/**
 * Materialise a **cross-runtime** fork's portable `{role, text}` history as a
 * real session in OpenCode's own SQLite store — the write-side counterpart to
 * `loadOpenCodeTranscript`, and OpenCode's `importHistoryForFork` (fidelity
 * "replayed"). Inserts one `session` row, one `message` row per turn (JSON data
 * mirroring OpenCode's own), and one `text` `part` row per message, keyed by the
 * same `ses_`/`msg_`/`prt_` ids OpenCode uses — the exact layout `opencode acp`
 * `session/load` resumes and `session/prompt` replays as real prior turns.
 * Returns the new session id, which is both the resume ref and the id. Throws on
 * any mismatch so the fork engine falls back to a seeded continuation prompt.
 */
export function writeOpenCodeHistory(
  history: ForkHistoryMessage[],
  ctx: ForkImportContext,
): { sessionFile: string; id: string } {
  if (process.env.BIVY_OPENCODE_NO_FORK_REPLAY === "1") {
    throw new Error("OpenCode fork replay disabled (BIVY_OPENCODE_NO_FORK_REPLAY=1)");
  }
  if (history.length === 0) throw new Error("Nothing to replay: fork history is empty");

  const db = openOpenCodeDb(true);
  try {
    const version = openCodeVersion(db);
    const { modelID, providerID } = resolveModel(ctx);
    const sessionId = openCodeId("ses_");
    const now = Date.now();
    const created = now - history.length; // slightly in the past so the stream orders below now
    const slug = `fork-${randomUUID().slice(0, 8)}`;
    const title = "Forked session";
    const cwd = ctx.cwd;
    const directory = cwd;
    const openCodePath = directory.replace(/^\/+/, "");

    db.exec("BEGIN");
    try {
      // project_id → project.id. OpenCode seeds a `global` project only once a
      // session needs it, so a fresh store may not have one yet — create it (same
      // row OpenCode itself writes) so the fork session's FK always resolves.
      db.prepare(
        `INSERT OR IGNORE INTO project (id, worktree, vcs, name, icon_url, icon_url_override, icon_color,
          time_created, time_updated, time_initialized, sandboxes, commands)
         VALUES ('global', '/', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, '[]', NULL)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory, path, title, version,
          cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
          model, time_created, time_updated)
         VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?, ?)`,
      ).run(
        sessionId,
        GLOBAL_PROJECT_ID,
        slug,
        directory,
        openCodePath,
        title,
        version,
        JSON.stringify({ id: modelID, providerID }),
        created,
        now,
      );

      const insertMessage = db.prepare(
        `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
      );
      const insertPart = db.prepare(
        `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`,
      );

      let previousId: string | null = null;
      history.forEach((turn, index) => {
        const messageId = openCodeId("msg_");
        const timeCreated = created + index;
        const timeCompleted = timeCreated + 1;
        let data: Record<string, unknown>;
        if (turn.role === "user") {
          data = {
            role: "user",
            time: { created: timeCreated },
            agent: "build",
            model: { providerID, modelID },
          };
        } else {
          data = {
            ...(previousId ? { parentID: previousId } : {}),
            role: "assistant",
            mode: "build",
            agent: "build",
            path: { cwd, root: "/" },
            cost: 0,
            tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
            modelID,
            providerID,
            time: { created: timeCreated, completed: timeCompleted },
            finish: "end_turn",
          };
        }
        insertMessage.run(messageId, sessionId, timeCreated, timeCompleted, JSON.stringify(data));
        insertPart.run(openCodeId("prt_"), messageId, sessionId, timeCreated, timeCompleted, JSON.stringify({ type: "text", text: turn.text }));
        previousId = messageId;
      });

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { sessionFile: sessionId, id: sessionId };
  } finally {
    db.close();
  }
}

type Row = Record<string, unknown>;

/** Deep-copy `value`, replacing any string that exactly matches a key in `map`
 *  with its mapped value. Used to remap old→new ids inside a row's JSON `data`
 *  (parentID, sessionID, …) without hardcoding the version-variable schema —
 *  only exact-id string matches are swapped, so unrelated text is never touched. */
function remapIds(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string") return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => remapIds(v, map));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = remapIds(v, map);
    return out;
  }
  return value;
}

/** Remap ids inside a JSON-string column (message/part `data`, session `model`). */
function remapJsonColumn(json: unknown, map: Map<string, string>): unknown {
  if (typeof json !== "string") return json;
  try {
    return JSON.stringify(remapIds(JSON.parse(json), map));
  } catch {
    return json; // not JSON (or unparseable) — leave verbatim
  }
}

/** Insert one row into `table` using its own column set (schema-version-robust). */
function insertRow(db: DatabaseSync, table: string, row: Row): void {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => "?").join(", ");
  db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`).run(...cols.map((c) => row[c] as never));
}

/**
 * Export an OpenCode session's own `session`/`message`/`part` rows verbatim for a
 * NATIVE same-runtime fork (fidelity "full"). Unlike `writeOpenCodeHistory` (which
 * collapses every turn to one text part), this carries each message's full `data`
 * JSON — model, tokens, timestamps, multi-part content — so an opencode→opencode
 * fork reproduces the session exactly. Returns undefined when the store or the id
 * is missing (the engine then degrades to replayed/seeded).
 */
export function exportOpenCodeSession(sessionRef: string): ForkNativePayload | undefined {
  let db: DatabaseSync;
  try {
    db = openOpenCodeDb(false);
  } catch {
    return undefined;
  }
  try {
    const session = db.prepare("SELECT * FROM session WHERE id = ?").get(sessionRef) as Row | undefined;
    if (!session) return undefined;
    const messages = db.prepare("SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id").all(sessionRef) as Row[];
    const parts = db.prepare("SELECT * FROM part WHERE session_id = ? ORDER BY time_created, id").all(sessionRef) as Row[];
    return { runtimeId: "opencode", kind: "opencode-rows", data: { session, messages, parts, sourceId: sessionRef } };
  } finally {
    db.close();
  }
}

/**
 * Import a payload from `exportOpenCodeSession` into a BRAND-NEW OpenCode session
 * (fidelity "full"): mint fresh `ses_`/`msg_`/`prt_` ids, remap every FK + nested
 * id reference, retarget the session's directory/path (and model when requested),
 * and re-INSERT the rows verbatim otherwise — preserving each message's full
 * `data`. Never touches the source. THROWS on an unreproducible payload (wrong
 * kind, missing session row, incompatible store) so the fork engine degrades to
 * the replayed/seeded tiers. Honors BIVY_OPENCODE_NO_FORK_REPLAY.
 */
export function importOpenCodeSession(payload: ForkNativePayload, ctx: ForkImportContext): { sessionFile: string; id: string } {
  if (process.env.BIVY_OPENCODE_NO_FORK_REPLAY === "1") {
    throw new Error("OpenCode fork transport disabled (BIVY_OPENCODE_NO_FORK_REPLAY=1)");
  }
  if (payload.kind !== "opencode-rows") throw new Error(`Unexpected OpenCode fork payload kind: ${payload.kind}`);
  const data = payload.data as { session?: Row; messages?: Row[]; parts?: Row[] } | undefined;
  const srcSession = data?.session;
  if (!srcSession || typeof srcSession.id !== "string") throw new Error("OpenCode fork payload has no session row");
  const messages = Array.isArray(data?.messages) ? data!.messages : [];
  const parts = Array.isArray(data?.parts) ? data!.parts : [];

  // Build the old→new id remap (session + every message + every part).
  const map = new Map<string, string>();
  const newSessionId = openCodeId("ses_");
  map.set(String(srcSession.id), newSessionId);
  for (const m of messages) if (typeof m.id === "string") map.set(m.id, openCodeId("msg_"));
  for (const p of parts) if (typeof p.id === "string") map.set(p.id, openCodeId("prt_"));

  const { modelID, providerID } = resolveModel(ctx);
  const directory = ctx.cwd;
  const openCodePath = directory.replace(/^\/+/, "");

  const db = openOpenCodeDb(true);
  try {
    db.exec("BEGIN");
    try {
      // Ensure the fork's project FK resolves (OpenCode seeds `global` lazily).
      const now = Date.now();
      db.prepare(
        `INSERT OR IGNORE INTO project (id, worktree, vcs, name, icon_url, icon_url_override, icon_color,
          time_created, time_updated, time_initialized, sandboxes, commands)
         VALUES ('global', '/', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, '[]', NULL)`,
      ).run(now, now);

      // Session row: remap ids, retarget cwd/path, refresh slug (avoid a UNIQUE
      // collision), stamp the requested model, and force the shared `global`
      // project so the FK always resolves on the destination.
      const sessionRow: Row = { ...srcSession };
      for (const k of Object.keys(sessionRow)) sessionRow[k] = remapIds(sessionRow[k], map);
      sessionRow.id = newSessionId;
      if ("project_id" in sessionRow) sessionRow.project_id = GLOBAL_PROJECT_ID;
      if ("slug" in sessionRow) sessionRow.slug = `fork-${randomUUID().slice(0, 8)}`;
      if ("directory" in sessionRow) sessionRow.directory = directory;
      if ("path" in sessionRow) sessionRow.path = openCodePath;
      if ("model" in sessionRow && ctx.model?.id) sessionRow.model = JSON.stringify({ id: modelID, providerID });
      else if ("model" in sessionRow) sessionRow.model = remapJsonColumn(sessionRow.model, map);
      insertRow(db, "session", sessionRow);

      for (const src of messages) {
        const row: Row = {};
        for (const [k, v] of Object.entries(src)) row[k] = k === "data" ? remapJsonColumn(v, map) : remapIds(v, map);
        insertRow(db, "message", row);
      }
      for (const src of parts) {
        const row: Row = {};
        for (const [k, v] of Object.entries(src)) row[k] = k === "data" ? remapJsonColumn(v, map) : remapIds(v, map);
        insertRow(db, "part", row);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { sessionFile: newSessionId, id: newSessionId };
  } finally {
    db.close();
  }
}

/**
 * Reconstruct a session's conversation from OpenCode's store as normalized
 * RuntimeMessages (role + content + timestamp), the same shape loadCodexTranscript
 * produces — the fast path behind reopening a resumed session (see
 * ProtocolRuntimeOptions.loadHistory). Best-effort: a missing/unreadable store or
 * unknown session yields an empty list, never a throw.
 */
export function loadOpenCodeTranscript(sessionRef: string): RuntimeMessage[] {
  const messages: RuntimeMessage[] = [];
  let db: DatabaseSync;
  try {
    db = openOpenCodeDb(false);
  } catch {
    return messages;
  }
  try {
    const rows = db
      .prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id")
      .all(sessionRef) as Array<{ id: string; time_created: number; data: string }>;
    const partRows = db.prepare("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id").all(sessionRef) as Array<{ message_id: string; data: string }>;
    const partsByMessage = new Map<string, string>();
    for (const part of partRows) {
      let text = "";
      try {
        const parsed = JSON.parse(part.data) as { type?: string; text?: unknown };
        if (parsed.type === "text" && typeof parsed.text === "string") text = parsed.text;
      } catch {
        // unreadable part — skip its text
      }
      if (!text) continue;
      partsByMessage.set(part.message_id, (partsByMessage.get(part.message_id) ?? "") + text);
    }
    for (const row of rows) {
      let parsed: { role?: unknown };
      try {
        parsed = JSON.parse(row.data) as { role?: unknown };
      } catch {
        continue;
      }
      if (parsed.role !== "user" && parsed.role !== "assistant") continue;
      const content = partsByMessage.get(row.id);
      if (!content) continue;
      messages.push({ role: parsed.role, content, timestamp: row.time_created });
    }
  } finally {
    db.close();
  }
  return messages;
}

/**
 * Remove a session from OpenCode's own store so a user-initiated delete in the
 * app actually sticks. Children (message/part rows) are removed explicitly so the
 * cleanup works regardless of the FK action a given OpenCode version declares;
 * `event`/`event_sequence` rows are left to OpenCode's own reaper (a fork session
 * never writes them). Best-effort: returns true when a session row was removed; a
 * missing store or unknown id is not an error. The write-side counterpart to
 * loadOpenCodeTranscript.
 */
export function deleteOpenCodeSession(sessionRef: string): boolean {
  let db: DatabaseSync;
  try {
    db = openOpenCodeDb(true);
  } catch {
    return false;
  }
  try {
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM part WHERE session_id = ?").run(sessionRef);
      db.prepare("DELETE FROM message WHERE session_id = ?").run(sessionRef);
      const result = db.prepare("DELETE FROM session WHERE id = ?").run(sessionRef);
      db.exec("COMMIT");
      return result.changes > 0;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

/**
 * Locate the OpenCode session a `bivy run opencode` produced when there is no
 * pinned id (OpenCode mints its own `ses_…` ids at TUI start): the earliest
 * top-level session whose `directory` is `cwd` and that was created at/after
 * `since` (the run-terminal's creation time, minus a small skew). Mirrors
 * discoverCodexSessionForCwd; best-effort — a missing store or no match is
 * undefined, never a throw. Verified against opencode 1.18.23's `session` table
 * (`directory`, `time_created`, `parent_id`).
 */
export function discoverOpenCodeSessionForCwd(cwd: string, since = 0): { id: string } | undefined {
  let db: DatabaseSync;
  try {
    db = openOpenCodeDb(false);
  } catch {
    return undefined;
  }
  try {
    const skewMs = 5_000;
    const row = db
      .prepare("SELECT id FROM session WHERE directory = ? AND parent_id IS NULL AND time_created >= ? ORDER BY time_created ASC, id LIMIT 1")
      .get(path.resolve(cwd), since - skewMs) as { id?: string } | undefined;
    return row?.id ? { id: row.id } : undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}
