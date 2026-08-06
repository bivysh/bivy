// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useSyncExternalStore } from "react";
import type { AppState } from "@bivy/core";
import { controller } from "./controller.js";

/**
 * Subscribe a component to the shared SessionStore. Because the store swaps in a
 * new immutable AppState on every change, `useSyncExternalStore` re-renders
 * exactly when something the component reads has changed — no manual DOM sync.
 */
export function useAppState(): AppState {
  return useSyncExternalStore(controller.store.subscribe, controller.store.getState);
}

export { controller };
