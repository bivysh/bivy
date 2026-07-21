// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Single append-only per-session event log (docs/dramatic-simplification-plan.md,
// slice 2). A session's transcript detail used to live in THREE whole-file JSON
// stores — `intermediate-messages/<id>.json`, `tool-activities/<id>.json`, and the
// base transcript `transcripts/<id>.json` — each rewritten in full on every change
// and each able to drift from the others. This collapses all of them into one
// append-only JSONL log (`event-log/<id>.jsonl`): writes append, and history is
// DERIVED by replaying the log.
//
// The log carries two independent projections, distinguished by `bivyKind`:
//   - OVERLAY entries (`intermediate` / `tool`): reasoning + tool-activity detail,
//     folded by `replayExtras` (reproducing the legacy per-kind fold) into the flat
//     `extras` list `mergeTranscript` consumes.
//   - BASE entries (`base`): the runtime's own transcript (user prompts + assistant
//     text). The base is a SNAPSHOT that is overwritten each turn and SHRINKS on
//     compaction, so it cannot be appended naively. Instead each snapshot is stored
//     as a bounded DELTA against the previous one: a `reset:false` record carrying
//     only the new tail when the snapshot merely extends the last (the common case),
//     or a `reset:true` record carrying the full snapshot when it shrinks or a
//     prefix message changed (compaction / in-place mutation). `baseReplay` folds
//     these back — reset replaces, non-reset extends — reproducing the last snapshot
//     exactly, so the fold is behaviour-preserving while keeping the file bounded
//     (~O(total messages)) instead of O(turns × transcript size).
//
// The two projections are independent: base records and overlay records may be
// interleaved in any order on disk; each replay reads only its own kind.

import fs from "node:fs";

import { normalizedIntermediateText, thinkingTextFromContent, mergeTranscript, type SidecarMessage } from "./transcript-merge.js";
import type { RuntimeMessage } from "../runtime/types.js";

/** One appended overlay record: an intermediate-reasoning or tool-activity entry. */
export interface EventLogEntry extends SidecarMessage {
  bivyKind: "intermediate" | "tool";
}

/**
 * One appended base-transcript record. `reset:true` carries a full snapshot that
 * replaces the working base on replay; `reset:false` carries only the tail messages
 * appended since the previous snapshot. See the file header.
 */
export interface BaseLogEntry {
  bivyKind: "base";
  reset: boolean;
  createdAt: number;
  messages: RuntimeMessage[];
}

/** Any record the log can hold. */
export type LogRecord = EventLogEntry | BaseLogEntry;

function isOverlay(value: unknown): value is EventLogEntry {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { bivyKind?: unknown }).bivyKind;
  return (kind === "intermediate" || kind === "tool") && typeof (value as { afterMessageCount?: unknown }).afterMessageCount === "number";
}

function isBase(value: unknown): value is BaseLogEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as { bivyKind?: unknown; messages?: unknown; reset?: unknown };
  return record.bivyKind === "base" && Array.isArray(record.messages) && typeof record.reset === "boolean";
}

function isRecord(value: unknown): value is LogRecord {
  return isOverlay(value) || isBase(value);
}

/**
 * Fold the intermediate-reasoning entries exactly as the legacy incremental
 * upsert did (`upsertIntermediateMessage` in server.ts): last write wins per id;
 * a same-text/same-anchor entry under a DIFFERENT id is merged onto the first
 * (keeping its id and the earlier `createdAt`); the result is ordered by
 * `afterMessageCount` then `createdAt`. Replaying the append log through this
 * reproduces the array the legacy store held.
 */
export function foldIntermediate(entries: readonly EventLogEntry[]): EventLogEntry[] {
  const out: EventLogEntry[] = [];
  for (const entry of entries) {
    const entryText = normalizedIntermediateText(thinkingTextFromContent(entry.content));
    const index = out.findIndex((m) => m.id != null && m.id === entry.id);
    if (index >= 0) {
      out[index] = entry;
    } else {
      const dup = entryText
        ? out.findIndex((m) => m.id !== entry.id && m.afterMessageCount === entry.afterMessageCount && normalizedIntermediateText(thinkingTextFromContent(m.content)) === entryText)
        : -1;
      if (dup >= 0) out[dup] = { ...out[dup], ...entry, id: out[dup]!.id, createdAt: Math.min(out[dup]!.createdAt, entry.createdAt) };
      else out.push(entry);
    }
    out.sort((a, b) => a.afterMessageCount - b.afterMessageCount || a.createdAt - b.createdAt);
  }
  return out;
}

/**
 * Fold the tool-activity entries exactly as the legacy `upsertToolActivityMessage`
 * did: merge onto an existing id (`{...existing, ...entry}`), else append; order by
 * `afterMessageCount` then `createdAt`; keep only the most recent 500.
 */
export function foldTool(entries: readonly EventLogEntry[]): EventLogEntry[] {
  let out: EventLogEntry[] = [];
  for (const entry of entries) {
    const index = out.findIndex((m) => m.id != null && m.id === entry.id);
    if (index >= 0) out[index] = { ...out[index], ...entry };
    else out.push(entry);
    out.sort((a, b) => a.afterMessageCount - b.afterMessageCount || a.createdAt - b.createdAt);
    out = out.slice(-500);
  }
  return out;
}

/**
 * Replay a session's overlay entries into the flat `extras` list `mergeTranscript`
 * consumes — the intermediate entries folded first, then the tool entries, matching
 * the legacy `[...loadIntermediateMessages, ...loadToolActivityMessages]` order.
 * Base records are ignored (they are folded separately by `baseReplay`).
 */
export function replayExtras(entries: readonly LogRecord[]): SidecarMessage[] {
  const intermediate: EventLogEntry[] = [];
  const tool: EventLogEntry[] = [];
  for (const entry of entries) {
    if (entry.bivyKind === "intermediate") intermediate.push(entry);
    else if (entry.bivyKind === "tool") tool.push(entry);
  }
  return [...foldIntermediate(intermediate), ...foldTool(tool)];
}

/**
 * Replay a session's base records into the base transcript: `reset` replaces the
 * working array, non-reset extends it with its tail. The result equals the last
 * full snapshot the server persisted, exactly. Overlay records are ignored.
 */
export function baseReplay(entries: readonly LogRecord[]): RuntimeMessage[] {
  let base: RuntimeMessage[] = [];
  for (const entry of entries) {
    if (entry.bivyKind !== "base") continue;
    if (entry.reset) base = [...entry.messages];
    else base = base.concat(entry.messages);
  }
  return base;
}

/** Parse a JSONL log body into valid records, skipping malformed/blank lines. */
export function parseLog(body: string): LogRecord[] {
  const out: LogRecord[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (isRecord(value)) out.push(value);
    } catch {}
  }
  return out;
}

/**
 * Append-only, coalesced, throttled JSONL log store — the write+read companion to
 * the legacy `SidecarStore`, but appending lines instead of rewriting the whole
 * file. In-memory state keeps reads cheap; disk writes coalesce to at most one per
 * `throttleMs` per session (a burst of same-id deltas within a window collapses to
 * one appended line). Durability at boundaries is explicit `flush()` (turn-end,
 * close, delete, shutdown), mirroring `SidecarStore`.
 */
export class EventLog {
  private disk = new Map<string, LogRecord[]>();
  private pending = new Map<string, Map<string, LogRecord>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private lastFlush = new Map<string, number>();
  private counters = new Map<string, number>();
  // Per-message JSON of the base snapshot the log currently represents, so the next
  // snapshot can be diffed (prefix-compared) into a bounded delta. Seeded from disk
  // on first use of a session after a restart.
  private baseKeys = new Map<string, string[]>();

  constructor(
    private dir: string,
    private pathFor: (id: string) => string,
    private redact: (text: string) => string = (t) => t,
    private throttleMs = 500,
  ) {}

  private load(id: string): LogRecord[] {
    const cached = this.disk.get(id);
    if (cached) return cached;
    let data: LogRecord[] = [];
    try {
      data = parseLog(fs.readFileSync(this.pathFor(id), "utf8"));
    } catch {}
    this.disk.set(id, data);
    return data;
  }

  /** Allocate a unique synthetic coalescing key (for id-less records). */
  private syntheticKey(id: string): string {
    const next = (this.counters.get(id) ?? 0) + 1;
    this.counters.set(id, next);
    return `#${next}`;
  }

  /** Queue a fully-formed record into the pending batch and schedule a flush. */
  private enqueue(id: string, key: string, record: LogRecord): void {
    let batch = this.pending.get(id);
    if (!batch) { batch = new Map(); this.pending.set(id, batch); }
    // Same key within a flush window coalesces to one line (streaming deltas of one
    // logical entry). Id-less records get a unique synthetic key so they never merge.
    batch.set(key, record);
    if (this.timers.has(id)) return; // a trailing flush is already scheduled
    const elapsed = Date.now() - (this.lastFlush.get(id) ?? 0);
    if (elapsed >= this.throttleMs) this.flush(id);
    else this.timers.set(id, setTimeout(() => { this.timers.delete(id); this.flush(id); }, this.throttleMs - elapsed));
  }

  /** Coalesce an overlay entry into the pending batch and schedule a flush. */
  append(id: string, entry: EventLogEntry): void {
    this.load(id);
    // Snapshot the entry: the server reuses one live object for a streaming reasoning
    // block, reassigning `.content` per delta. A shallow copy captures the state at
    // append time so the pending/on-disk record can't change under us.
    this.enqueue(id, entry.id ?? this.syntheticKey(id), { ...entry });
  }

  /**
   * Record the runtime's current base transcript snapshot as a bounded delta. The
   * snapshot is diffed against the base the log already represents: a prefix-extend
   * appends only the new tail (`reset:false`), anything else appends a full replace
   * (`reset:true`). A no-op (identical snapshot) appends nothing. The stored messages
   * are a deep JSON copy, so a later in-place mutation of the runtime's objects can't
   * change what was recorded.
   */
  appendBaseSnapshot(id: string, messages: readonly RuntimeMessage[]): void {
    this.load(id);
    let prevKeys = this.baseKeys.get(id);
    if (!prevKeys) {
      prevKeys = baseReplay(this.entries(id)).map((m) => JSON.stringify(m));
      this.baseKeys.set(id, prevKeys);
    }
    const nextKeys = messages.map((m) => JSON.stringify(m));
    // Identical snapshot → nothing to record.
    if (nextKeys.length === prevKeys.length && prevKeys.every((k, i) => k === nextKeys[i])) return;
    // A prefix-EXTEND (strictly longer, every prior message unchanged) appends only
    // the new tail; anything else — a shrink (compaction), a changed prefix message
    // (in-place mutation), or the first snapshot (empty prev, nothing to extend) —
    // appends a full reset. Rebuild the recorded messages from the serialized form:
    // a free deep copy that also matches exactly what will land on disk.
    const extend = prevKeys.length > 0 && nextKeys.length > prevKeys.length && prevKeys.every((k, i) => k === nextKeys[i]);
    const record: BaseLogEntry = extend
      ? { bivyKind: "base", reset: false, createdAt: Date.now(), messages: nextKeys.slice(prevKeys.length).map((s) => JSON.parse(s) as RuntimeMessage) }
      : { bivyKind: "base", reset: true, createdAt: Date.now(), messages: nextKeys.map((s) => JSON.parse(s) as RuntimeMessage) };
    this.baseKeys.set(id, nextKeys);
    this.enqueue(id, this.syntheticKey(id), record);
  }

  /** Replay the overlay entries (disk + pending) into the flat `extras` list. */
  read(id: string): SidecarMessage[] {
    return replayExtras(this.entries(id));
  }

  /** Replay the base records (disk + pending) into the base transcript. */
  readBase(id: string): RuntimeMessage[] {
    return baseReplay(this.entries(id));
  }

  /**
   * The full derived conversation: overlay detail merged into the base transcript.
   * Prefers the runtime's own live transcript when it has one; otherwise replays the
   * base persisted in the log (a reopened session on a runtime that can't rebuild it).
   * This is the single read path — it absorbs the former `mergeConversation` helper.
   */
  deriveHistory(id: string, runtimeBase?: readonly RuntimeMessage[]): RuntimeMessage[] {
    const base = runtimeBase && runtimeBase.length ? runtimeBase : this.readBase(id);
    return mergeTranscript(base, this.read(id));
  }

  /** Full ordered record list (already-flushed followed by pending). */
  entries(id: string): LogRecord[] {
    const disk = this.load(id);
    const batch = this.pending.get(id);
    return batch && batch.size ? [...disk, ...batch.values()] : disk;
  }

  /** Whether this session has any overlay entries (in memory or on disk). */
  hasEntries(id: string): boolean {
    return this.entries(id).some((e) => e.bivyKind === "intermediate" || e.bivyKind === "tool");
  }

  /** Whether this session has any base record (in memory or on disk). */
  hasBase(id: string): boolean {
    return this.entries(id).some((e) => e.bivyKind === "base");
  }

  flush(id: string): void {
    const timer = this.timers.get(id);
    if (timer) { clearTimeout(timer); this.timers.delete(id); }
    const batch = this.pending.get(id);
    if (!batch || !batch.size) return;
    const lines = [...batch.values()];
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.pathFor(id), this.redact(lines.map((e) => JSON.stringify(e)).join("\n") + "\n"));
      const disk = this.load(id);
      disk.push(...lines);
      batch.clear();
      this.lastFlush.set(id, Date.now());
    } catch {}
  }

  /**
   * Overwrite a session's log with a known-complete set of records. Used by the
   * one-time legacy→log migration to seed the log before it becomes the sole source.
   * Replaces the file and the in-memory state and discards any pending batch, since
   * `entries` is authoritative. The replays re-fold on read, so passing already-folded
   * records is exact and idempotent.
   */
  rewrite(id: string, entries: readonly LogRecord[]): void {
    const copy = entries.map((e) => ({ ...e }));
    const timer = this.timers.get(id);
    if (timer) { clearTimeout(timer); this.timers.delete(id); }
    this.pending.delete(id);
    this.baseKeys.delete(id);
    this.disk.set(id, copy);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const body = copy.length ? copy.map((e) => JSON.stringify(e)).join("\n") + "\n" : "";
      fs.writeFileSync(this.pathFor(id), this.redact(body));
      this.lastFlush.set(id, Date.now());
    } catch {}
  }

  /** Cancel any pending write and forget the session (used when it's deleted). */
  drop(id: string): void {
    const timer = this.timers.get(id);
    if (timer) { clearTimeout(timer); this.timers.delete(id); }
    this.disk.delete(id);
    this.pending.delete(id);
    this.lastFlush.delete(id);
    this.counters.delete(id);
    this.baseKeys.delete(id);
  }

  flushAll(): void {
    for (const id of this.pending.keys()) this.flush(id);
  }
}
