// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Ask the browser to keep this origin's storage durable.
//
// The device's pairing keypair (IndexedDB) and the session token + room keys
// (localStorage) are what let the app reconnect to a node without re-pairing.
// iOS home-screen PWAs are aggressive about evicting script-writable storage
// (the 7-day ITP cap, plus eviction under storage pressure); when it goes, the
// app pairs again on the next launch and the control plane records a brand-new
// "signed-in device" every time. Requesting persistent storage exempts the
// origin from that best-effort eviction. Installed PWAs are granted it readily;
// on browsers without the API this is a harmless no-op.

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = navigator?.storage;
    if (!storage?.persist) return false;
    if (typeof storage.persisted === "function" && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
