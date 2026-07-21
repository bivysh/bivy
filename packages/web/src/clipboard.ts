// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Copy text to the clipboard. Prefers the async Clipboard API but falls back to
 * a hidden-textarea `execCommand("copy")` for non-secure contexts (e.g. reaching
 * the node over a plain-http LAN IP), where `navigator.clipboard` is undefined.
 * Returns whether the copy was accepted.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* blocked / not focused — fall through to the legacy path */
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
