// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Which saved state belongs to a widget. Transcript entry ids are minted per
// load, so they cannot be the key; what the widget IS can: the same page placed
// with the same data is the same widget on every device and after every reload.
// An agent that places one page twice with the same data gives each an `id`.

/** FNV-1a, 32-bit, as 8 hex digits. A label, not a security boundary. */
function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function widgetKey(opts: { id?: unknown; source: string; data?: unknown }): string {
  if (typeof opts.id === "string" && /^[\w.:-]{1,64}$/.test(opts.id)) return `id:${opts.id}`;
  return `w:${fnv(opts.source)}:${fnv(JSON.stringify(opts.data ?? null))}`;
}
