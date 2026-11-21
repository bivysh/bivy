// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad

/** A text paste at least this long is attached as a file instead of filling
 *  the composer: logs, docs and transcripts stay readable on a phone, and
 *  every agent reads the file from its workspace. */
export const LONG_PASTE_CHARS = 10_000;

/** The file name for a long paste, numbered past the ones already attached
 *  ("pasted-text.md", "pasted-text-2.md", …), or null for a normal paste. */
export function longPasteName(text: string, attachedNames: readonly string[]): string | null {
  if (text.length < LONG_PASTE_CHARS) return null;
  const taken = new Set(attachedNames);
  if (!taken.has("pasted-text.md")) return "pasted-text.md";
  for (let n = 2; ; n += 1) {
    const name = `pasted-text-${n}.md`;
    if (!taken.has(name)) return name;
  }
}
