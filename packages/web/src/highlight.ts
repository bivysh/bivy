// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Client-side syntax highlighting for rendered markdown code blocks.
//
// The markdown renderer (@bivy/core) emits plain `<pre><code class="language-x">`
// with the code text escaped. We highlight in the DOM after that HTML is injected
// so the shared, cached renderer stays dependency-free and the cost only lands on
// the code blocks actually on screen. highlight.js/lib/common bundles the ~common
// languages (js, ts, python, bash, json, css, …) — enough for chat code without
// the full multi-hundred-language payload — and is loaded lazily (its own chunk),
// so a session with no code blocks never pays for it.
import { writeClipboard } from "./clipboard.js";

type Hljs = (typeof import("highlight.js/lib/common"))["default"];

let hljsPromise: Promise<Hljs> | null = null;

// Matches ChatView's CopyGlyph/CheckGlyph so the per-code-block button reads the
// same as the message-level copy affordance. Inline SVG (not a component) because
// this decorates raw innerHTML-injected markup outside React's tree.
const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden><polyline points="20 6 9 17 4 12"/></svg>';

/**
 * Add a copy button to every code block inside `root` that doesn't have one yet.
 * The markdown renderer emits `<pre><code>…</code></pre>`; we wrap the `<pre>` in
 * a relatively-positioned `.code-block-wrap` and hang an absolutely-positioned
 * button off the wrapper (NOT the `<pre>` itself — the `<pre>` is the horizontal
 * scroller, so a button inside it would slide away with the code). Wrapping,
 * rather than positioning inside, also keeps the button pinned to the corner
 * regardless of scroll. Runs after the same innerHTML injection highlightCode
 * hooks into; idempotent because a React re-render replaces innerHTML wholesale
 * (dropping wrapper + button), and the "already wrapped" guard skips re-wrapping
 * within a single pass. Copies the `<code>` text verbatim. */
export function decorateCodeBlocks(root: HTMLElement | null): void {
  if (!root) return;
  const blocks = Array.from(root.querySelectorAll<HTMLPreElement>("pre")).filter(
    (pre) => pre.querySelector("code") && !pre.parentElement?.classList.contains("code-block-wrap"),
  );
  for (const pre of blocks) {
    const wrap = document.createElement("div");
    wrap.className = "code-block-wrap";
    pre.parentNode?.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy-btn";
    btn.title = "Copy code";
    btn.setAttribute("aria-label", "Copy code");
    btn.innerHTML = COPY_ICON;
    let resetTimer: ReturnType<typeof setTimeout> | null = null;
    btn.addEventListener("click", () => {
      const code = pre.querySelector("code")?.textContent ?? "";
      void writeClipboard(code).then((ok) => {
        if (!ok) return;
        btn.classList.add("copied");
        btn.innerHTML = CHECK_ICON;
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = COPY_ICON;
        }, 1200);
      });
    });
    wrap.appendChild(btn);
  }
}

/** Highlight every not-yet-highlighted `<pre><code>` block inside `root`. */
export function highlightCode(root: HTMLElement | null): void {
  if (!root) return;
  const pending = Array.from(root.querySelectorAll<HTMLElement>("pre code")).filter(
    (el) => el.dataset.highlighted !== "yes",
  );
  if (pending.length === 0) return;
  hljsPromise ??= import("highlight.js/lib/common").then((m) => m.default);
  void hljsPromise.then((hljs) => {
    for (const el of pending) {
      // The node may have been replaced by a re-render before the chunk landed.
      if (!el.isConnected || el.dataset.highlighted === "yes") continue;
      // If the fence names a language hljs doesn't know, drop the class so it
      // auto-detects instead of falling back to unstyled plaintext (and warning).
      const lang = Array.from(el.classList)
        .find((c) => c.startsWith("language-"))
        ?.slice("language-".length);
      if (lang && !hljs.getLanguage(lang)) el.classList.remove(`language-${lang}`);
      hljs.highlightElement(el);
    }
  });
}
