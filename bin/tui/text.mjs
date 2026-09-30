// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Terminal cell arithmetic for `bivy tui`: visible width of styled text,
// truncating, padding and wrapping it without splitting an escape sequence.

const ANSI = /\x1b\[[0-9;]*m/g;
// Wide (two-cell) characters: CJK, Hangul, fullwidth forms and most emoji.
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;
// Zero-width: combining marks, variation selectors, joiners.
const ZERO = /[\p{Mn}\p{Cf}]/u;

export const stripAnsi = (text) => String(text).replace(ANSI, "");

function charWidth(ch) {
  if (ZERO.test(ch)) return 0;
  return WIDE.test(ch) ? 2 : 1;
}

export function width(text) {
  let w = 0;
  for (const ch of stripAnsi(text)) w += charWidth(ch);
  return w;
}

/** Split styled text into [escape | character] tokens. */
function tokens(text) {
  return String(text).match(/\x1b\[[0-9;]*m|[\s\S]/gu) ?? [];
}

/** Cut to at most `max` cells, ending in "…" when anything was dropped. */
export function truncate(text, max) {
  if (max <= 0) return "";
  if (width(text) <= max) return text;
  let out = "";
  let w = 0;
  for (const token of tokens(text)) {
    if (token.startsWith("\x1b")) { out += token; continue; }
    const cw = charWidth(token);
    if (w + cw > max - 1) break;
    out += token;
    w += cw;
  }
  return `${out}…\x1b[0m`;
}

/** Exactly `size` cells: truncated, or padded with spaces. */
export function fit(text, size) {
  const cut = truncate(text, size);
  return cut + " ".repeat(Math.max(0, size - width(cut)));
}

/** Word-wrap plain text to `max` cells per line, hard-breaking long words. */
export function wrap(text, max) {
  const lines = [];
  for (const paragraph of String(text).replace(/\t/g, "  ").split("\n")) {
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      if (!word) continue;
      if (width(line + word) <= max) { line += word; continue; }
      if (line.trim()) lines.push(line.trimEnd());
      line = /^\s+$/.test(word) ? "" : word;
      while (width(line) > max) {
        let head = "";
        for (const ch of line) { if (width(head + ch) > max) break; head += ch; }
        lines.push(head);
        line = line.slice(head.length);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
