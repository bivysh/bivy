// SPDX-License-Identifier: AGPL-3.0-only
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

/**
 * Give an overlay its own history entry so the browser Back gesture behaves
 * like a native mobile back button: it closes the topmost overlay first and
 * only then navigates the underlying app. Programmatic closes consume the
 * entry too, keeping Back from reopening the overlay later.
 */
export function useModalBack(onBack: () => void): () => void {
  const callback = useRef(onBack);
  callback.current = onBack;
  const active = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    history.pushState({ __bivyModal: true }, "", location.href);
    active.current = true;
    const onPopState = () => {
      if (!active.current) return;
      active.current = false;
      callback.current();
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      // If the overlay was removed by some other route/state change, remove
      // its sentinel entry so the next Back gesture does not land on a stale
      // copy of the current page.
      if (active.current) {
        active.current = false;
        history.back();
      }
    };
  }, []);

  return () => {
    if (!active.current) return;
    // Traverse to the entry before the modal sentinel first. The popstate
    // handler then closes the route at that entry, replacing the original
    // overlay URL instead of leaving it behind in the history stack.
    history.back();
  };
}
