// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The composer's @ picker: spot an `@word` being typed at the caret, and put a
// chosen workspace path in its place. The path goes in as plain text, so it
// works the same for every agent.

export interface FileMention {
  /** Index of the `@`. */
  start: number;
  /** Index just past the word (the caret). */
  end: number;
  /** What follows the `@`, e.g. `src/comp`. */
  query: string;
}

/** The `@word` the caret is at the end of, if any. The `@` must start the
 *  text or follow whitespace, so an email address never opens the picker. */
export function fileMentionAt(text: string, caret: number): FileMention | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  if (text[start] !== "@") return null;
  // The caret has to be at the end of the word, not in the middle of it.
  if (caret < text.length && !/\s/.test(text[caret]!)) return null;
  return { start, end: caret, query: text.slice(start + 1, caret) };
}

/** Replace the mention with `@path`. A folder keeps the picker open inside it
 *  (trailing `/`, no space); a file ends the word with a space. */
export function insertFileMention(text: string, mention: FileMention, entry: { path: string; type: "dir" | "file" }): { text: string; caret: number } {
  const inserted = `@${entry.path}${entry.type === "dir" ? "/" : " "}`;
  const after = text.slice(mention.end);
  const rest = entry.type === "file" ? after.replace(/^ /, "") : after;
  return { text: text.slice(0, mention.start) + inserted + rest, caret: mention.start + inserted.length };
}
