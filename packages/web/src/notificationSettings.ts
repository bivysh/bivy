// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { normalizeNotificationPreferences, type NotificationPreferences } from "@bivy/core";

const BADGE_ENABLED_KEY = "bivy.appIconBadge.enabled";
const PREFS_SNAPSHOT_KEY = "bivy.notificationPreferences.snapshot";
const CHANGE_EVENT = "bivy-notification-settings-change";

let cachedPreferencesRaw: string | null | undefined;
let cachedPreferences: NotificationPreferences | null = null;

function emitChange() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function getAppIconBadgeEnabled(): boolean {
  return localStorage.getItem(BADGE_ENABLED_KEY) !== "0";
}

export function setAppIconBadgeEnabled(enabled: boolean) {
  localStorage.setItem(BADGE_ENABLED_KEY, enabled ? "1" : "0");
  emitChange();
}

export function subscribeNotificationSettings(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === BADGE_ENABLED_KEY || event.key === PREFS_SNAPSHOT_KEY) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function getNotificationPreferencesSnapshot(): NotificationPreferences | null {
  const raw = localStorage.getItem(PREFS_SNAPSHOT_KEY);
  if (raw === cachedPreferencesRaw) return cachedPreferences;
  cachedPreferencesRaw = raw;
  if (!raw) {
    cachedPreferences = null;
    return cachedPreferences;
  }
  try {
    cachedPreferences = normalizeNotificationPreferences(JSON.parse(raw));
  } catch {
    cachedPreferences = null;
  }
  return cachedPreferences;
}

export function setNotificationPreferencesSnapshot(preferences: NotificationPreferences) {
  localStorage.setItem(PREFS_SNAPSHOT_KEY, JSON.stringify(preferences));
  emitChange();
}
