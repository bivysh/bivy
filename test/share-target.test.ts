// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Share-target landing (`/share?title=…&text=…&url=…`): the Android share
// sheet (Web Share Target) and the iOS "Send to Bivy" Shortcut both open this
// URL; the client stashes the payload, redirects to /sessions/new, and shows a
// destination sheet — new session by default, or any recent session. See
// packages/web/src/shareTarget.ts and ShareDestinationSheet.tsx.
import assert from "node:assert/strict";
import {
  applyShareTarget,
  clearPendingShare,
  mergeSharedText,
  peekPendingShare,
  PENDING_SHARE_KEY,
  seedSessionDraft,
  sharedDraftText,
} from "../packages/web/src/shareTarget.js";
import { parsePreviewLanding } from "../packages/web/src/previewLanding.js";
import { shareDestinations } from "../packages/web/src/components/ShareDestinationSheet.js";
import {
  readComposerDraft,
  writeComposerDraft,
  type DraftStorage,
} from "../packages/web/src/composerDraft.js";
import type { SessionSummary } from "@bivy/core";

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

// --- applyShareTarget: stashes the payload and redirects --------------------
const pending = new MemoryStorage();
assert.equal(applyShareTarget("/sessions/abc", "?text=nope", pending, new MemoryStorage()), null, "non-share paths are untouched");
assert.equal(pending.values.size, 0);

assert.equal(applyShareTarget("/share", "?text=from%20the%20sheet", pending, new MemoryStorage()), "/sessions/new");
assert.equal(peekPendingShare(pending), "from the sheet");
// Peek does not consume — the sheet may not render until after a sign-in.
assert.equal(peekPendingShare(pending), "from the sheet");

// A second share before the first was placed appends to the stash.
assert.equal(applyShareTarget("/share/", "?text=another%20thing", pending, new MemoryStorage()), "/sessions/new");
assert.equal(peekPendingShare(pending), "from the sheet\n\nanother thing");

// An empty payload still redirects (the share URL must never linger) but
// leaves the stash alone.
assert.equal(applyShareTarget("/share", "", pending, new MemoryStorage()), "/sessions/new");
assert.equal(peekPendingShare(pending), "from the sheet\n\nanother thing");

// A named session skips the destination sheet: the text lands in that
// session's draft (merged, never replacing what was typed) and it opens.
const named = new MemoryStorage();
writeComposerDraft(named, "s-1", "typed", []);
assert.equal(applyShareTarget("/share", "?session=s-1&text=restart%20the%20server", pending, named), "/sessions/s-1");
assert.equal(readComposerDraft(named, "s-1").text, "typed\n\nrestart the server");
assert.equal(peekPendingShare(pending), "from the sheet\n\nanother thing", "a named share bypasses the stash");
assert.equal(applyShareTarget("/share", "?session=..%2Fx&text=hi", pending, named), "/sessions/new", "malformed ids fall back to the sheet");

clearPendingShare(pending);
assert.equal(peekPendingShare(pending), null);
assert.equal(pending.values.has(PENDING_SHARE_KEY), false);

// --- seedSessionDraft: destination drafts merge, attachments survive --------
const drafts = new MemoryStorage();
seedSessionDraft(drafts, null, "into the new draft");
assert.equal(readComposerDraft(drafts, null).text, "into the new draft");

writeComposerDraft(drafts, "session-9", "half-typed reply", [
  { kind: "file", name: "notes.txt", size: 4, mimeType: "text/plain" },
]);
seedSessionDraft(drafts, "session-9", "shared payload");
assert.deepEqual(readComposerDraft(drafts, "session-9"), {
  version: 2,
  text: "half-typed reply\n\nshared payload",
  attachments: [{ kind: "file", name: "notes.txt", size: 4, mimeType: "text/plain" }],
});
// Delivering the same share twice never duplicates it.
seedSessionDraft(drafts, "session-9", "shared payload");
assert.equal(readComposerDraft(drafts, "session-9").text, "half-typed reply\n\nshared payload");

// --- shareDestinations: newest first, provisioning placeholders excluded ----
const session = (sessionId: string, updatedAt?: number, pendingLaunch?: boolean): SessionSummary =>
  ({ sessionId, name: sessionId, updatedAt, pendingLaunch });
const picked = shareDestinations([
  session("old", 100),
  session("provisioning", 900, true),
  session("new", 500),
  session("undated"),
]);
assert.deepEqual(picked.map((s) => s.sessionId), ["new", "old", "undated"]);
assert.equal(shareDestinations(Array.from({ length: 20 }, (_, i) => session(`s${i}`, i))).length, 8, "list stays scannable");

console.log("share-target: all tests passed");

// --- parsePreviewLanding: a stable preview address coming back after sign-in --
{
  const app = "a".repeat(32), view = "b".repeat(32);
  assert.deepEqual(parsePreviewLanding("/sessions/s-1", `#preview=${app}.${view}.${encodeURIComponent("/invoices?q=1")}`), { sessionId: "s-1", appId: app, viewId: view, path: "/invoices?q=1" });
  // Only same-origin paths survive; anything else resumes at the app's root.
  assert.equal(parsePreviewLanding("/sessions/s-1", `#preview=${app}.${view}.${encodeURIComponent("//evil.example")}`)?.path, "/");
  assert.equal(parsePreviewLanding("/sessions/s-1", `#preview=${app}.${view}.${encodeURIComponent("https://evil.example")}`)?.path, "/");
  assert.equal(parsePreviewLanding("/sessions/new", `#preview=${app}.${view}./`), null);
  assert.equal(parsePreviewLanding("/sessions/s-1", `#preview=nothex.${view}./`), null);
}
