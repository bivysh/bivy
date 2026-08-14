// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Lazily render fenced ```mermaid blocks after markdown has entered the DOM.
// Mermaid is intentionally kept out of the initial bundle: most conversations
// never contain a diagram, and the renderer is substantially larger than the
// rest of the markdown enhancements.

type Mermaid = (typeof import("mermaid"))["default"];

let mermaidPromise: Promise<Mermaid> | null = null;
let renderQueue: Promise<void> = Promise.resolve();
let diagramId = 0;

function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      fontFamily: "inherit",
    });
    return mermaid;
  });
  return mermaidPromise;
}

function isMermaidCode(code: Element): code is HTMLElement {
  return code instanceof HTMLElement && Array.from(code.classList).some((name) => name.toLowerCase() === "language-mermaid");
}

/**
 * Replace each not-yet-rendered Mermaid code fence below `root` with its SVG.
 * Work is serialized because Mermaid uses temporary global DOM nodes while it
 * renders. If React replaces a message while the lazy chunk is loading, the
 * disconnected-node checks make the queued work a no-op.
 *
 * Invalid diagrams deliberately remain as escaped source code. This gives the
 * reader a useful, copyable fallback instead of an empty message.
 */
export function renderMermaidDiagrams(root: HTMLElement | null): void {
  if (!root) return;
  const diagrams = Array.from(root.querySelectorAll("pre > code")).filter(isMermaidCode);
  for (const code of diagrams) {
    const pre = code.parentElement;
    if (!pre || pre.dataset.mermaidState) continue;
    pre.dataset.mermaidState = "queued";
    const source = code.textContent ?? "";

    renderQueue = renderQueue.then(async () => {
      if (!pre.isConnected || !root.contains(pre)) return;
      try {
        const mermaid = await loadMermaid();
        if (!pre.isConnected || !root.contains(pre)) return;
        const id = `bivy-mermaid-${++diagramId}`;
        const { svg, bindFunctions } = await mermaid.render(id, source);
        if (!pre.isConnected || !root.contains(pre)) return;

        const figure = document.createElement("div");
        figure.className = "mermaid-diagram";
        figure.setAttribute("role", "img");
        figure.setAttribute("aria-label", "Mermaid diagram");
        figure.innerHTML = svg;
        pre.replaceWith(figure);
        bindFunctions?.(figure);
      } catch {
        // Preserve the original fence when Mermaid cannot parse it. The state
        // also prevents repeated render attempts on unrelated React effects.
        pre.dataset.mermaidState = "error";
        pre.title = "This Mermaid diagram could not be rendered";
      }
    });
  }
}
