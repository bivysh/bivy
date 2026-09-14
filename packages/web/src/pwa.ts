// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Service-worker registration + update signalling, using vite-plugin-pwa's
// generated registration. No hand-versioned caches: Workbox fingerprints every
// asset, and we surface a "needs refresh" flag the UI can act on when the user
// chooses — never mid-session.

import { registerSW } from "virtual:pwa-register";
import { canActivateUpdate, setUpdateAvailable } from "./pwaLifecycle.js";
import { activateWaitingWorker } from "./pwaUpdate.js";

type UpdateListener = (needRefresh: boolean) => void;

const listeners = new Set<UpdateListener>();
let needRefresh = false;

export function initPwa(): void {
  registerSW({
    immediate: true,
    // Reload is owned by the explicit click below. A different tab activating
    // the worker must not reload this tab and discard its unsent work.
    onNeedReload() {},
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
export async function reloadForUpdate(): Promise<boolean> {
  if (!canActivateUpdate()) return false;
  const registration = await navigator.serviceWorker?.getRegistration();
  if (!canActivateUpdate()) return false;
  await activateWaitingWorker(registration);
  // Work may have started while activation was in flight. Keep the prompt so
  // the user can reload later, even though no waiting worker remains.
  if (!canActivateUpdate()) return false;
  window.location.reload();
  return true;
}
