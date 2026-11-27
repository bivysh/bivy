// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// ↑/↓ in the composer steps through the prompts already sent in this session,
// like a shell or an agent's own terminal UI. Pure helpers: the list comes
// from the transcript, so it works the same for every agent.

import { handoffSeedOf, skillInvocationOf, stripAttachmentPlaceholders, type TranscriptEntry } from "@bivy/core";

/** The session's sent prompts, oldest first, as the user typed them. Repeats
 *  of the previous prompt are kept once. */
export function sentPrompts(entries: readonly TranscriptEntry[]): string[] {
  const prompts: string[] = [];
  for (const entry of entries) {
    if (entry.role !== "user" || handoffSeedOf(entry.text)) continue;
    const sent = stripAttachmentPlaceholders(entry.text);
    const text = (skillInvocationOf(sent) ?? sent).trim();
    if (text && text !== prompts[prompts.length - 1]) prompts.push(text);
  }
  return prompts;
}

/** Where the composer is in the history: the recalled prompt's index, or null
 *  when it shows the user's own text. */
export type HistoryPosition = number | null;

/**
 * The position an arrow key moves to, or undefined when the key should keep
 * its usual meaning (move the caret). Arrows step only while the composer is
 * empty or still shows the recalled prompt unedited, and only from its first
 * line (↑) or last line (↓), so moving within a multi-line prompt still works.
 */
export function stepPromptHistory(opts: {
  prompts: readonly string[];
  position: HistoryPosition;
  key: "ArrowUp" | "ArrowDown";
  text: string;
  caret: number;
}): HistoryPosition | undefined {
  const { prompts, position, key, text, caret } = opts;
  const recalled = position !== null && prompts[position] === text;
  if (text !== "" && !recalled) return undefined;
  if (key === "ArrowUp") {
    if (text.slice(0, caret).includes("\n")) return undefined;
    const next = position === null || !recalled ? prompts.length - 1 : position - 1;
    return next >= 0 ? next : undefined;
  }
  if (!recalled || text.slice(caret).includes("\n")) return undefined;
  return position + 1 < prompts.length ? position + 1 : null;
}
