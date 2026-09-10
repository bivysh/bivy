import assert from "node:assert/strict";
import { getNotificationPreferencesSnapshot, setNotificationPreferencesSnapshot } from "../packages/web/src/notificationSettings.js";

const values = new Map<string, string>();
const listeners: Event[] = [];
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  },
});
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { dispatchEvent(event: Event) { listeners.push(event); } },
});

assert.equal(getNotificationPreferencesSnapshot(), null);
setNotificationPreferencesSnapshot({
  question_asked: true,
  approval_requested: false,
  agent_waiting: true,
  session_done: true,
  session_error: true,
  terminal_bell: true,
});
assert.equal(listeners.length, 1);
const first = getNotificationPreferencesSnapshot();
const second = getNotificationPreferencesSnapshot();
assert.ok(first);
assert.equal(first, second, "useSyncExternalStore snapshots must be referentially stable between changes");
assert.equal(first.approval_requested, false);

values.set("bivy.notificationPreferences.snapshot", JSON.stringify({ approval_requested: true }));
const changed = getNotificationPreferencesSnapshot();
assert.notEqual(changed, first);
assert.equal(changed?.approval_requested, true);
assert.equal(changed?.terminal_bell, true, "missing preferences are normalized to enabled");
assert.equal(getNotificationPreferencesSnapshot(), changed);

values.set("bivy.notificationPreferences.snapshot", "not json");
assert.equal(getNotificationPreferencesSnapshot(), null);
assert.equal(getNotificationPreferencesSnapshot(), null);

console.log("notification-settings: ok");
