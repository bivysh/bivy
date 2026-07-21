// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Service-worker registration + update signalling, using vite-plugin-pwa's
// generated registration. No hand-versioned caches: Workbox fingerprints every
// asset, and we surface a "needs refresh" flag the UI can act on when the user
// chooses — never mid-session.

import { registerSW } from "virtual:pwa-register";

type UpdateListener = (needRefresh: boolean) => void;

let applyUpdate: (reload?: boolean) => Promise<void> = async () => {};
const listeners = new Set<UpdateListener>();
let needRefresh = false;

export function initPwa(): void {
  applyUpdate = registerSW({
    immediate: true,
    onNeedRefresh() {
      needRefresh = true;
      for (const l of listeners) l(true);
    },
  });
}

export function onUpdateAvailable(fn: UpdateListener): () => void {
  listeners.add(fn);
  if (needRefresh) fn(true);
  return () => listeners.delete(fn);
}

/** Activate the waiting worker and reload into the new version. */
export function reloadForUpdate(): void {
  void applyUpdate(true);
}
