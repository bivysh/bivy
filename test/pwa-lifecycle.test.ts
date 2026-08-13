import assert from "node:assert/strict";
import type { PromptAttachment } from "@bivy/core";
import {
  clearComposerDraft,
  composerDraftKey,
  composerMetadataKey,
  readComposerDraft,
  writeComposerDraft,
  type DraftStorage,
} from "../packages/web/src/composerDraft.js";
import { updateBlockers, type PwaLifecycleState } from "../packages/web/src/pwaLifecycle.js";

class MemoryStorage implements DraftStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const storage = new MemoryStorage();
const attachment: PromptAttachment = {
  kind: "file", name: "private.txt", size: 12, mimeType: "text/plain", text: "secret bytes",
};
writeComposerDraft(storage, "session-1", "unfinished prompt", [attachment]);
assert.equal(storage.getItem(composerDraftKey("session-1")), "unfinished prompt");
const rawMetadata = storage.getItem(composerMetadataKey("session-1"))!;
assert.equal(rawMetadata.includes("secret bytes"), false, "attachment contents never enter browser storage");
assert.deepEqual(readComposerDraft(storage, "session-1"), {
  version: 1,
  text: "unfinished prompt",
  attachments: [{ kind: "file", name: "private.txt", size: 12, mimeType: "text/plain" }],
});

storage.setItem(composerMetadataKey("broken"), "not json");
assert.deepEqual(readComposerDraft(storage, "broken").attachments, [], "corrupt metadata fails closed");
// Rapid writes are synchronous and last-write-wins without mixing attachment metadata.
writeComposerDraft(storage, "session-1", "first", [attachment]);
writeComposerDraft(storage, "session-1", "second", []);
assert.deepEqual(readComposerDraft(storage, "session-1"), { version: 1, text: "second", attachments: [] });
clearComposerDraft(storage, "session-1");
assert.equal(storage.getItem(composerDraftKey("session-1")), null);
assert.equal(storage.getItem(composerMetadataKey("session-1")), null);

const unavailable: DraftStorage = {
  getItem() { throw new Error("storage denied"); },
  setItem() { throw new Error("quota exceeded"); },
  removeItem() { throw new Error("storage denied"); },
};
assert.doesNotThrow(() => writeComposerDraft(unavailable, null, "still composable", [attachment]));
assert.deepEqual(readComposerDraft(unavailable, null), { version: 1, text: "", attachments: [] });

const lifecycle: PwaLifecycleState = {
  updateAvailable: true,
  installChoice: null,
  standalone: false,
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
assert.deepEqual(updateBlockers({ ...lifecycle, hasDraft: false, pendingAttachments: 0, readingAttachments: false, turnActive: false, locallyQueuedPrompts: 0 }), []);

console.log("pwa-lifecycle: all tests passed");
