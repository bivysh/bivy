// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Share-target landing (`/share?title=…&text=…&url=…`): the Android share
// sheet (Web Share Target) and the iOS "Send to Bivy" Shortcut both open this
// URL; the client folds the payload into the new-session composer draft and
// redirects to /sessions/new. See packages/web/src/shareTarget.ts.
import assert from "node:assert/strict";
import {
  applyShareTarget,
  mergeSharedText,
  sharedDraftText,
} from "../packages/web/src/shareTarget.js";
import {
  readComposerDraft,
  writeComposerDraft,
  type DraftStorage,
} from "../packages/web/src/composerDraft.js";

class MemoryStorage implements DraftStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

// --- sharedDraftText: any subset of title/text/url composes cleanly ---------
assert.equal(sharedDraftText(new URLSearchParams("text=hello")), "hello");
assert.equal(
  sharedDraftText(new URLSearchParams("title=A%20bug&text=It%20crashes&url=https%3A%2F%2Fx.test%2Fissue%2F1")),
  "A bug\nIt crashes\nhttps://x.test/issue/1",
);
// Android often repeats the link inside `text` — never duplicate it.
assert.equal(
  sharedDraftText(new URLSearchParams("text=See%20https%3A%2F%2Fx.test%2Fp&url=https%3A%2F%2Fx.test%2Fp")),
  "See https://x.test/p",
);
// Blank / whitespace-only parts drop out entirely.
assert.equal(sharedDraftText(new URLSearchParams("title=%20%20&url=https%3A%2F%2Fx.test")), "https://x.test");
assert.equal(sharedDraftText(new URLSearchParams("")), "");

// --- mergeSharedText: append, never clobber; re-shares are idempotent -------
assert.equal(mergeSharedText("", "shared"), "shared");
assert.equal(mergeSharedText("  \n", "shared"), "shared");
assert.equal(mergeSharedText("existing draft", "shared"), "existing draft\n\nshared");
assert.equal(mergeSharedText("existing draft\n", "shared"), "existing draft\n\nshared");
assert.equal(mergeSharedText("already has shared inside", "shared"), "already has shared inside");
assert.equal(mergeSharedText("existing", ""), "existing");

// --- applyShareTarget: seeds the "new" draft and redirects ------------------
const storage = new MemoryStorage();
assert.equal(applyShareTarget("/sessions/abc", "?text=nope", storage), null, "non-share paths are untouched");
assert.equal(storage.values.size, 0);

assert.equal(applyShareTarget("/share", "?text=from%20the%20sheet", storage), "/sessions/new");
assert.equal(readComposerDraft(storage, null).text, "from the sheet");

// A second share appends below the existing draft and keeps attachments.
writeComposerDraft(storage, null, readComposerDraft(storage, null).text, [
  { kind: "file", name: "notes.txt", size: 4, mimeType: "text/plain" },
]);
assert.equal(applyShareTarget("/share/", "?text=another%20thing", storage), "/sessions/new");
assert.deepEqual(readComposerDraft(storage, null), {
  version: 2,
  text: "from the sheet\n\nanother thing",
  attachments: [{ kind: "file", name: "notes.txt", size: 4, mimeType: "text/plain" }],
});

// An empty payload still redirects (the share URL must never linger) but
// leaves the draft alone.
assert.equal(applyShareTarget("/share", "", storage), "/sessions/new");
assert.equal(readComposerDraft(storage, null).text, "from the sheet\n\nanother thing");

console.log("share-target: all tests passed");
