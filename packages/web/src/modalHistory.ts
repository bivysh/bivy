// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

interface HistoryLayer {
  id: number;
  returnKey?: string;
  onBack: () => void;
  closing: boolean;
  disposed: boolean;
}

export interface ModalHistoryHandle {
  close(): void;
  dispose(): void;
}

// Unlike history.back(), a keyed traversal skips joint-history entries owned
// by preview iframes (which do not emit popstate on the parent window).
function navigationHistory() {
  return (window as unknown as { navigation?: {
    currentEntry?: { key: string };
    traverseTo(key: string): unknown;
  } }).navigation;
}

let nextLayerId = 0;
const historyLayers: HistoryLayer[] = [];
const waitingHistoryLayers: HistoryLayer[] = [];
let traversing: HistoryLayer | undefined;
const settled: Array<() => void> = [];

function flushSettled(): void {
  if (traversing || historyLayers.some((layer) => layer.closing)) return;
  for (const fn of settled.splice(0)) fn();
}

/** Runs `fn` once a closing sheet's history step has finished. Navigating
 *  from a sheet's pick before then is undone when that step goes back. */
export function afterModalHistory(fn: () => void): void {
  settled.push(fn);
  // After React has unmounted the sheet (and its close has begun).
  setTimeout(flushSettled, 0);
}

// A Back traversal is asynchronous. Keep ownership of its sentinel until
// popstate arrives, even if React unmounts the overlay in the meantime. Otherwise
// confirming a nested dialog queues Back once from the button and again from
// each unmount, potentially navigating past the app and back to GitHub OAuth.
function drainModalHistory(): void {
  if (traversing) return;
  const top = historyLayers.at(-1);
  if (top?.closing) {
    traversing = top;
    const navigation = navigationHistory();
    if (top.returnKey && navigation) navigation.traverseTo(top.returnKey);
    else history.back();
    return;
  }
  for (const layer of waitingHistoryLayers.splice(0)) {
    if (layer.disposed) continue;
    layer.returnKey = navigationHistory()?.currentEntry?.key;
    history.pushState({ ...history.state, __bivyModal: layer.id }, "", location.href);
    historyLayers.push(layer);
  }
  if (historyLayers.at(-1)?.closing) drainModalHistory();
  else flushSettled();
}

// Imported by the router so this runs before any route listeners. Window
// popstate listeners run in registration order; capture does not reorder them.
if (typeof window !== "undefined") {
  window.addEventListener("popstate", (event) => {
    // Iframe navigations share the top-level Back stack. A traversal within
    // a preview still has this sheet's sentinel: don't consume its ownership
    // or let the router interpret it as session navigation. Closing drains
    // those entries before consuming the actual sentinel.
    const top = historyLayers.at(-1);
    if (top && event.state?.__bivyModal === top.id) {
      event.stopImmediatePropagation();
      traversing = undefined;
      queueMicrotask(drainModalHistory);
      return;
    }
    const layer = historyLayers.pop();
    traversing = undefined;
    if (!layer) return;
    // A modal sentinel is not session navigation. Claim it before routing can
    // reset the transcript and unmount the activity sheet underneath us.
    event.stopImmediatePropagation();
    if (!layer.disposed) layer.onBack();
    // Let React finish unmounting related overlays before consuming their
    // entries. A programmatic pop must never dismiss an unrelated lower layer.
    queueMicrotask(drainModalHistory);
  });
}

export function pushModalHistory(onBack: () => void): ModalHistoryHandle {
  const layer: HistoryLayer = { id: ++nextLayerId, onBack, closing: false, disposed: false };
  // StrictMode's simulated first mount is disposed before it mutates history.
  queueMicrotask(() => {
    if (layer.disposed) return;
    waitingHistoryLayers.push(layer);
    drainModalHistory();
  });
  return {
    close() {
      if (layer.closing) return;
      layer.closing = true;
      drainModalHistory();
    },
    dispose() {
      layer.disposed = true;
      layer.closing = true;
      drainModalHistory();
    },
  };
}
