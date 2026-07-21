// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Fold Bivy's per-session sidecars (intermediate reasoning + tool activity) into
// a runtime's base transcript. Pure and unit-tested (test/transcript-merge.test.ts)
// so the placement logic is verifiable without the daemon.
//
// Why anchoring by TIME, not by an absolute message index:
//   Each sidecar entry recorded `afterMessageCount = getMessages().length` at the
//   moment it happened. That's an absolute index into a list whose length
//   CHANGES — it grows during a turn, and (for runtimes like Claude Code) SHRINKS
//   when the conversation is compacted. After compaction the base transcript is
//   shorter than the counts the sidecar recorded, so every over-the-end entry got
//   clamped to `base.length` and piled up AFTER the final message (a big clump of
//   recent tool cards below the newest reply — the reported bug).
//   Messages and sidecar entries both carry an epoch-ms time (`timestamp` /
//   `createdAt`), and surviving messages keep their timestamps across compaction,
//   so placing each entry after the base messages that precede it IN TIME is
//   stable. We fall back to the old clamped-count placement only when timestamps
//   are unavailable.

import type { RuntimeMessage } from "../runtime/types.js";

export interface SidecarMessage {
  role?: string;
  content?: unknown;
  bivyKind?: "intermediate" | "tool";
  /** Absolute `getMessages().length` when recorded (legacy anchor / fallback). */
  afterMessageCount: number;
  /** Epoch ms when the entry was produced (primary, compaction-stable anchor). */
  createdAt: number;
  id?: string;
  [key: string]: unknown;
}

export function normalizedIntermediateText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function thinkingTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      const type = String(record.type || "").toLowerCase();
      if (type === "thinking") return typeof record.thinking === "string" ? record.thinking : typeof record.text === "string" ? record.text : "";
      if (type === "reasoning") return typeof record.reasoning === "string" ? record.reasoning : typeof record.text === "string" ? record.text : "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Parse a `timestamp` field (epoch-ms number or ISO string) to epoch ms. */
function toTs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

/**
 * Non-decreasing timeline of the base messages' timestamps. Gaps (a message with
 * no timestamp) carry forward the previous value so the array stays monotonic and
 * binary-searchable. `hasTime` is false when NO base message is timestamped, in
 * which case callers fall back to count-based placement.
 */
function baseTimeline(base: readonly RuntimeMessage[]): { times: number[]; hasTime: boolean } {
  const times = new Array<number>(base.length);
  let last = 0;
  let hasTime = false;
  for (let i = 0; i < base.length; i++) {
    const t = toTs((base[i] as { timestamp?: unknown } | undefined)?.timestamp);
    if (t !== undefined) {
      hasTime = true;
      if (t > last) last = t;
    }
    times[i] = last;
  }
  return { times, hasTime };
}

/** Count of `times` entries ≤ `value` (upper bound). `times` is non-decreasing. */
function countAtOrBefore(times: readonly number[], value: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function insertionIndex(base: readonly RuntimeMessage[], timeline: { times: number[]; hasTime: boolean }, entry: SidecarMessage): number {
  if (timeline.hasTime && typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)) {
    return countAtOrBefore(timeline.times, entry.createdAt);
  }
  // Legacy / no-timestamp fallback: clamp the absolute count into range.
  return Math.max(0, Math.min(base.length, entry.afterMessageCount));
}

/**
 * Merge the `extras` (intermediate + tool-activity sidecar entries) into `base`,
 * each placed by time (see file header). Deduplicates intermediate reasoning that
 * already appears in an adjacent persisted message or was emitted twice.
 */
export function mergeTranscript(base: readonly RuntimeMessage[], extras: readonly SidecarMessage[]): RuntimeMessage[] {
  if (!extras.length) return base as RuntimeMessage[];
  const timeline = baseTimeline(base);
  const byIndex = new Map<number, SidecarMessage[]>();
  const seenIntermediate = new Set<string>();
  for (const entry of extras) {
    const index = insertionIndex(base, timeline, entry);
    if (entry.bivyKind === "intermediate") {
      const text = normalizedIntermediateText(thinkingTextFromContent(entry.content));
      // Skip a sidecar reasoning copy when the adjacent persisted message already
      // carries the same reasoning, and dedupe repeated stream-final copies.
      const alreadyInTranscript = text && [base[index - 1], base[index]].some((message) => normalizedIntermediateText(thinkingTextFromContent(message?.content)) === text);
      const dedupeKey = `${index}:${text}`;
      if (alreadyInTranscript || seenIntermediate.has(dedupeKey)) continue;
      if (text) seenIntermediate.add(dedupeKey);
    }
    const bucket = byIndex.get(index) ?? [];
    bucket.push(entry);
    byIndex.set(index, bucket);
  }
  const merged: RuntimeMessage[] = [];
  for (let i = 0; i <= base.length; i++) {
    const bucket = byIndex.get(i);
    if (bucket) merged.push(...(bucket.sort((a, b) => a.createdAt - b.createdAt) as unknown as RuntimeMessage[]));
    if (i < base.length) merged.push(base[i]!);
  }
  return merged;
}
