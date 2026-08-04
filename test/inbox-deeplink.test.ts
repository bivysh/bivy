import assert from "node:assert/strict";
import type { InboxItem } from "../packages/core/src/inbox.js";
import { resolveInboxDeepLink, inboxDeepLinkQuery } from "../packages/web/src/inboxDeepLink.js";

// B3 — an inbox item / push tap focuses the EXACT approval, question, or outcome,
// not just the session top. This is the shared targeting logic behind both.

let failures = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}\n      ${(error as Error).message}`); }
}

const item = (over: Partial<InboxItem>): InboxItem => ({
  id: "i1", kind: "session", severity: "info", source: "session", state: "unresolved",
  title: "t", createdAt: "2026-08-04T00:00:00Z", updatedAt: "2026-08-04T00:00:00Z", ...over,
} as InboxItem);

check("approval focuses its exact card in the session", () => {
  const link = resolveInboxDeepLink(item({ kind: "approval", sessionId: "s1", nodeId: "n1", targetId: "appr-9" }));
  assert.deepEqual(link, { target: "session", sessionId: "s1", nodeId: "n1", attentionId: "appr-9" });
});

check("question focuses its exact card", () => {
  assert.equal(resolveInboxDeepLink(item({ kind: "question", sessionId: "s1", targetId: "q-3" })).attentionId, "q-3");
});

check("outcome focuses the session's outcome anchor (targetId = sessionId)", () => {
  const link = resolveInboxDeepLink(item({ kind: "outcome", sessionId: "s2", targetId: "s2" }));
  assert.equal(link.target, "session");
  assert.equal(link.attentionId, "s2", "outcome must land on its exact anchor, not just open the session");
});

check("a session item without a target opens the session, no false anchor", () => {
  const link = resolveInboxDeepLink(item({ kind: "session", sessionId: "s3" }));
  assert.equal(link.target, "session");
  assert.equal(link.attentionId, undefined);
});

check("queue and provider items route to their settings tab", () => {
  assert.deepEqual(resolveInboxDeepLink(item({ kind: "queue", source: "queue", sessionId: undefined })), { target: "settings", settingsTab: "queue" });
  assert.deepEqual(resolveInboxDeepLink(item({ kind: "provider", source: "provider", sessionId: undefined })), { target: "settings", settingsTab: "providers" });
});

check("push query encodes the exact focus target for a cold open", () => {
  assert.equal(inboxDeepLinkQuery(item({ kind: "approval", sessionId: "s1", targetId: "appr-9" })), "/?session=s1&attention=appr-9");
  assert.equal(inboxDeepLinkQuery(item({ kind: "outcome", sessionId: "s2", targetId: "s2" })), "/?session=s2&attention=s2");
  assert.equal(inboxDeepLinkQuery(item({ kind: "queue", source: "queue", sessionId: undefined })), "/?settings=queue");
});

if (failures > 0) { console.error(`\n${failures} inbox-deeplink test(s) failed`); process.exit(1); }
console.log("\ninbox-deeplink: all tests passed");
