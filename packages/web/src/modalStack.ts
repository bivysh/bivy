// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef } from "react";

// A LIFO stack of open modal layers (sheets, dialogs, popovers) so a single
// global Escape handler only ever fires the *topmost* one. Before this, several
// overlays each registered their own `window` keydown→Escape listener, so one
// Escape press with a confirm dialog open inside Settings would cancel the
// dialog AND tear down the whole Settings modal underneath it — the classic
// "Escape closes too much" glitch. Now each layer registers here on open; the
// one on top owns Escape, and everything below it is inert until it closes.

type Handler = () => void;

interface Layer {
  handler: Handler;
}

const stack: Layer[] = [];
let installed = false;

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  // Capture phase so this runs before any element/React-level Escape handler
  // (e.g. a terminal forwarding Escape to its PTY, a textarea's own key logic).
  // We only claim the event — stopping propagation — when a layer is actually
  // open; otherwise the key passes through untouched, so app behaviour with no
  // modal open is exactly as before.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const top = stack[stack.length - 1];
      if (!top) return;
      e.stopPropagation();
      e.preventDefault();
      top.handler();
    },
    true,
  );
}

/** Register an Escape handler as a modal layer. Returns an unregister fn. */
export function pushModal(handler: Handler): () => void {
  install();
  const layer: Layer = { handler };
  stack.push(layer);
  return () => {
    const i = stack.lastIndexOf(layer);
    if (i >= 0) stack.splice(i, 1);
  };
}

/**
 * Close-on-Escape for a modal layer, coordinated so only the topmost open
 * layer responds. Pass `active` (default true) to gate registration on an
 * open flag for popovers that mount permanently and only sometimes show.
 */
export function useModalEscape(onEscape: () => void, active = true): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!active) return;
    return pushModal(() => ref.current());
  }, [active]);
}
