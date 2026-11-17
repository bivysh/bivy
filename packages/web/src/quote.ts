// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad

/** Text as a Markdown quote for the next message: every line behind "> ",
 *  blank lines kept as ">" so it stays one block, and a blank line after it so
 *  what the user types next starts below the quote. Empty text quotes nothing. */
export function quoteForReply(text: string): string {
  const body = text.replace(/\r\n?/g, "\n").trim();
  if (!body) return "";
  return `${body.split("\n").map((line) => (line.trim() ? `> ${line.trimEnd()}` : ">")).join("\n")}\n\n`;
}

/** The text selected inside `el`, or "" when the selection is empty or reaches
 *  outside it (a drag that ran into the next message quotes nothing partial). */
export function selectedTextWithin(el: Node | null, selection: Selection | null): string {
  if (!el || !selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  const range = selection.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return "";
  return selection.toString();
}
