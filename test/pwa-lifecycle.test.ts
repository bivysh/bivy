import assert from "node:assert/strict";
import type { PromptAttachment } from "@bivy/core";
import {
  clearComposerDraft,
  composerDraftKey,
  composerMetadataKey,
  composerSnapshotKey,
  readComposerDraft,
  writeComposerDraft,
  type DraftStorage,
} from "../packages/web/src/composerDraft.js";
import {
  canActivateUpdate,
  clearQueuedPrompts,
  describeAvailability,
  fallbackInstallChoice,
  getPwaLifecycleState,
  markPromptQueued,
  setFollowupQueuedPrompts,
  updateBlockers,
  type PwaLifecycleState,
} from "../packages/web/src/pwaLifecycle.js";

class MemoryStorage implements DraftStorage {
  values = new Map<string, string>();
  failSetFor: string | null = null;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (key === this.failSetFor) throw new Error("quota exceeded");
    this.values.set(key, value);
  }
  removeItem(key: string) { this.values.delete(key); }
}

const storage = new MemoryStorage();
const attachment: PromptAttachment = {
  kind: "file", name: "private.txt", size: 12, mimeType: "text/plain", text: "secret bytes",
};
writeComposerDraft(storage, "session-1", "unfinished prompt", [attachment]);
assert.equal(storage.getItem(composerDraftKey("session-1")), "unfinished prompt", "legacy text remains readable");
const rawSnapshot = storage.getItem(composerSnapshotKey("session-1"))!;
assert.equal(rawSnapshot.includes("secret bytes"), false, "attachment contents never enter browser storage");
assert.deepEqual(readComposerDraft(storage, "session-1"), {
  version: 2,
  text: "unfinished prompt",
  attachments: [{ kind: "file", name: "private.txt", size: 12, mimeType: "text/plain" }],
});

// Legacy v1 data migrates on read without trusting malformed metadata.
storage.setItem(composerDraftKey("legacy"), "older draft");
storage.setItem(composerMetadataKey("legacy"), JSON.stringify({
  version: 1,
  attachments: [{ kind: "file", name: "old.txt", size: 3, mimeType: "text/plain" }],
}));
assert.deepEqual(readComposerDraft(storage, "legacy"), {
  version: 2,
  text: "older draft",
  attachments: [{ kind: "file", name: "old.txt", size: 3, mimeType: "text/plain" }],
});
storage.setItem(composerMetadataKey("broken"), "not json");
assert.deepEqual(readComposerDraft(storage, "broken").attachments, [], "corrupt metadata fails closed");

// Rapid writes are synchronous, atomic snapshots are last-write-wins, and a
// quota failure keeps the previous coherent text/metadata pair.
writeComposerDraft(storage, "session-1", "first", [attachment]);
writeComposerDraft(storage, "session-1", "second", []);
assert.deepEqual(readComposerDraft(storage, "session-1"), { version: 2, text: "second", attachments: [] });
storage.failSetFor = composerSnapshotKey("session-1");
writeComposerDraft(storage, "session-1", "torn", [attachment]);
assert.deepEqual(readComposerDraft(storage, "session-1"), { version: 2, text: "second", attachments: [] });
storage.failSetFor = null;
clearComposerDraft(storage, "session-1");
assert.equal(storage.getItem(composerDraftKey("session-1")), null);
assert.equal(storage.getItem(composerMetadataKey("session-1")), null);
assert.equal(storage.getItem(composerSnapshotKey("session-1")), null);

const unavailable: DraftStorage = {
  getItem() { throw new Error("storage denied"); },
  setItem() { throw new Error("quota exceeded"); },
  removeItem() { throw new Error("storage denied"); },
};
assert.doesNotThrow(() => writeComposerDraft(unavailable, null, "still composable", [attachment]));
assert.deepEqual(readComposerDraft(unavailable, null), { version: 2, text: "", attachments: [] });

const lifecycle: PwaLifecycleState = {
  updateAvailable: true,
  installChoice: null,
  standalone: false,
  shellCached: true,
  firstSuccess: true,
  hasDraft: true,
  pendingAttachments: 1,
  readingAttachments: true,
  turnActive: true,
  locallyQueuedPrompts: 2,
};
assert.deepEqual(updateBlockers(lifecycle), [
  "the active turn finishes",
  "file reading finishes",
  "the unsent draft is sent or cleared",
  "pending attachments are sent or cleared",
  "locally queued prompts reach the Machine",
]);
assert.equal(canActivateUpdate(lifecycle), false);
const idle = { ...lifecycle, hasDraft: false, pendingAttachments: 0, readingAttachments: false, turnActive: false, locallyQueuedPrompts: 0 };
assert.deepEqual(updateBlockers(idle), []);
assert.equal(canActivateUpdate(idle), true);
assert.equal(canActivateUpdate({ ...idle, updateAvailable: false }), false);

assert.equal(describeAvailability("online", false, idle).kind, "live-control");
assert.equal(describeAvailability("reconnecting", true, idle).kind, "reconnecting");
assert.equal(describeAvailability("offline", true, idle).kind, "cached-transcript");
assert.equal(describeAvailability("offline", false, idle).kind, "cached-shell");
assert.equal(describeAvailability("offline", false, { ...idle, shellCached: false }).kind, "offline-page");
assert.equal(describeAvailability("online", true, { ...idle, locallyQueuedPrompts: 1 }).kind, "local-queue");
// An unreachable Machine is named and comes with the one actionable hint, so a
// phone user knows which machine to check and what to run there.
assert.match(describeAvailability("offline", true, idle, "macbook").detail, /Machine macbook is offline/);
assert.match(describeAvailability("offline", true, idle, "macbook").detail, /bivy status/);
assert.match(describeAvailability("offline", false, idle).detail, /The Machine is offline/);
assert.equal(describeAvailability("reconnecting", true, idle, "macbook").label, "Reconnecting to macbook");
assert.equal(describeAvailability("reconnecting", true, idle).label, "Reconnecting Machine");

// Reconnect buffering and visible follow-up queues are independent concurrent
// sources: reconnect recovery must not accidentally clear a queued follow-up.
setFollowupQueuedPrompts(2);
markPromptQueued();
assert.equal(getPwaLifecycleState().locallyQueuedPrompts, 3);
clearQueuedPrompts();
assert.equal(getPwaLifecycleState().locallyQueuedPrompts, 2);
setFollowupQueuedPrompts(0);
assert.equal(getPwaLifecycleState().locallyQueuedPrompts, 0);

assert.equal(fallbackInstallChoice("Mozilla/5.0 (iPhone) AppleWebKit Safari", "iPhone", 5), "ios");
assert.equal(fallbackInstallChoice("Mozilla/5.0 AppleWebKit Version/17.4 Safari/605.1.15", "MacIntel", 0), "safari");
assert.equal(fallbackInstallChoice("Mozilla/5.0 Chrome/124 Safari/537.36", "Linux", 0), null);
assert.equal(fallbackInstallChoice("Mozilla/5.0 (iPhone) Safari", "iPhone", 5, true), null);

console.log("pwa-lifecycle: all tests passed");
