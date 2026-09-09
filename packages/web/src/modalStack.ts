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
interface HistoryLayer {
  onBack: Handler;
  closing: boolean;
  disposed: boolean;
}

const historyLayers: HistoryLayer[] = [];
const waitingHistoryLayers: HistoryLayer[] = [];
let traversing: HistoryLayer | undefined;
let historyInstalled = false;

// A Back traversal is asynchronous. Keep ownership of its sentinel until
// popstate arrives, even if React unmounts the overlay in the meantime. Otherwise
// confirming a nested dialog queues Back once from the button and again from
// each unmount, potentially navigating past the app and back to GitHub OAuth.
function drainModalHistory(): void {
  if (traversing) return;
  const top = historyLayers.at(-1);
  if (top?.closing) {
    traversing = top;
    history.back();
    return;
  }
  for (const layer of waitingHistoryLayers.splice(0)) {
    if (layer.disposed) continue;
    history.pushState({ __bivyModal: true }, "", location.href);
    historyLayers.push(layer);
  }
  if (historyLayers.at(-1)?.closing) drainModalHistory();
}

function installModalHistory(): void {
  if (historyInstalled) return;
  historyInstalled = true;
  window.addEventListener("popstate", () => {
    const layer = historyLayers.pop();
    traversing = undefined;
    if (!layer) return;
    if (!layer.disposed) layer.onBack();
    // Let React finish unmounting related overlays before consuming their
    // entries. A programmatic pop must never dismiss an unrelated lower layer.
    queueMicrotask(drainModalHistory);
  });
}
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
  const layerRef = useRef<HistoryLayer | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    installModalHistory();
    let cancelled = false;
    const layer: HistoryLayer = { onBack: () => callback.current(), closing: false, disposed: false };
    layerRef.current = layer;

    // React StrictMode immediately cleans up and re-runs effects in development.
    // Deferring the sentinel means that simulated first run is cancelled before
    // it mutates history; otherwise its cleanup queues a Back navigation that
    // pops the second run's sentinel and closes the newly opened sheet.
    queueMicrotask(() => {
      if (cancelled) return;
      waitingHistoryLayers.push(layer);
      drainModalHistory();
    });

    return () => {
      cancelled = true;
      layer.disposed = true;
      layer.closing = true;
      layerRef.current = null;
      drainModalHistory();
    };
  }, []);

  return () => {
    const layer = layerRef.current;
    if (!layer || layer.closing) return;
    // Close at the destination entry, preserving route-based overlays' replace
    // semantics, but reserve this traversal so cleanup cannot request it twice.
    layer.closing = true;
    drainModalHistory();
  };
}
