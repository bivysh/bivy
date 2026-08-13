// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Service-worker registration + update signalling, using vite-plugin-pwa's
// generated registration. No hand-versioned caches: Workbox fingerprints every
// asset, and we surface a "needs refresh" flag the UI can act on when the user
// chooses — never mid-session.

import { registerSW } from "virtual:pwa-register";
import { canActivateUpdate, setUpdateAvailable } from "./pwaLifecycle.js";

type UpdateListener = (needRefresh: boolean) => void;

let applyUpdate: (reload?: boolean) => Promise<void> = async () => {};
const listeners = new Set<UpdateListener>();
let needRefresh = false;

export function initPwa(): void {
  applyUpdate = registerSW({
    immediate: true,
    onNeedRefresh() {
      needRefresh = true;
      setUpdateAvailable(true);
      for (const l of listeners) l(true);
    },
  });
}

export function onUpdateAvailable(fn: UpdateListener): () => void {
  listeners.add(fn);
  if (needRefresh) fn(true);
  return () => listeners.delete(fn);
}

/** Activate the waiting worker only after every user-work blocker clears. */
export function reloadForUpdate(): boolean {
  if (!canActivateUpdate()) return false;
  void applyUpdate(true);
  return true;
}
