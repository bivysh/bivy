// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "bivy.cloudMachines.enabled";
const EVENT_NAME = "bivy:cloud-machines-changed";

function readSnapshot(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT_NAME, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(EVENT_NAME, onStoreChange);
  };
}

export function cloudMachinesEnabled(): boolean {
  return readSnapshot();
}

export function setCloudMachinesEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Keep the in-memory UI responsive even if storage is unavailable.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT_NAME));
}

export function useCloudMachinesEnabled(): boolean {
  return useSyncExternalStore(subscribe, readSnapshot, () => false);
}
