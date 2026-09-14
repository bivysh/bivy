// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

interface HistoryLayer {
  onBack: () => void;
  closing: boolean;
  disposed: boolean;
}

export interface ModalHistoryHandle {
  close(): void;
  dispose(): void;
}

const historyLayers: HistoryLayer[] = [];
const waitingHistoryLayers: HistoryLayer[] = [];
let traversing: HistoryLayer | undefined;

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

// Imported by the router so this runs before any route listeners. Window
// popstate listeners run in registration order; capture does not reorder them.
if (typeof window !== "undefined") {
  window.addEventListener("popstate", (event) => {
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
  const layer: HistoryLayer = { onBack, closing: false, disposed: false };
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
