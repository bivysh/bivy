// SPDX-License-Identifier: AGPL-3.0-only
import type { TranscriptEntry } from "@bivy/core";

/** Keep user prompts, essential notices, and each turn's final answer while
 * preserving durable attachment output from any earlier assistant row. */
export function focusEntries(entries: TranscriptEntry[], working: boolean): TranscriptEntry[] {
  const keep: TranscriptEntry[] = [];
  let lastAssistant: TranscriptEntry | null = null;
  let lastAssistantWithText: TranscriptEntry | null = null;
  let attachments: NonNullable<TranscriptEntry["attachments"]> = [];
  const flush = () => {
    const retained = lastAssistantWithText ?? lastAssistant;
    if (retained) {
      if (attachments.length === 0) keep.push(retained);
      else {
        // An attachment event can settle on an earlier commentary bubble before
        // final prose arrives. Attachments are output, not interim narration, so
        // carry every unique file onto the answer Focus view retains.
        const seen = new Set<string>();
        const unique = attachments.filter((attachment) => {
          const key = attachment.hash || `${attachment.kind}:${attachment.name}:${attachment.size}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        keep.push({ ...retained, attachments: unique });
      }
    }
    lastAssistant = null;
    lastAssistantWithText = null;
    attachments = [];
  };
  for (const entry of entries) {
    if (entry.tool || entry.role === "thinking") continue;
    if (entry.role === "assistant") {
      lastAssistant = entry;
      if (entry.text || entry.streaming) lastAssistantWithText = entry;
      if (entry.attachments?.length) attachments.push(...entry.attachments);
      continue;
    }
    flush();
    keep.push(entry);
  }
  flush();
  if (!working) return keep;
  const currentTurn = keep.findLastIndex((entry) => entry.role === "user");
  return keep.flatMap((entry, index) => {
    const isCurrentAssistant = entry.role === "assistant" && (currentTurn < 0 || index > currentTurn);
    if (!isCurrentAssistant) return [entry];
    // Hide in-progress prose as before, but never hide files the agent has
    // already emitted. Their row remains and the final prose joins it on settle.
    return entry.attachments?.length ? [{ ...entry, text: "", html: undefined, streaming: false }] : [];
  });
}
