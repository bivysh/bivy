// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

const layers: ((event: PopStateEvent) => void)[] = [];

// Imported by the router so this runs before any route listeners. Window
// popstate listeners run in registration order; capture does not reorder them.
// Only the top modal can consume a Back event, even if it unmounts synchronously.
if (typeof window !== "undefined") {
  window.addEventListener("popstate", (event) => layers.at(-1)?.(event));
}

export function pushModalHistory(handler: (event: PopStateEvent) => void): () => void {
  layers.push(handler);
  return () => {
    const index = layers.indexOf(handler);
    if (index >= 0) layers.splice(index, 1);
  };
}
