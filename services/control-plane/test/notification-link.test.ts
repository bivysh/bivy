// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { notificationLink } from "../src/notification-link.js";
import { nativePushPayload } from "../src/apns.js";

const appId = "a".repeat(32);
const base = { nodeId: "node_1", sessionId: "s1" };
assert.deepEqual(notificationLink({ nodeId: "node_1", kind: "session_done" }), { url: "/", review: false });
assert.deepEqual(notificationLink({ ...base, kind: "app_notes", apps: { appId } }), { url: `/sessions/s1?node=node_1&apps=${appId}`, review: false });
// Reviewer notes carry an app ID only; anything else a node sends is dropped.
for (const apps of [{ appId: "not-hex" }, { appId: `${appId}&token=x` }, { appId, note: "secret note text" }, "x", undefined]) {
  const { url } = notificationLink({ ...base, kind: "app_notes", apps });
  assert.ok(!url.includes("secret") && !url.includes("token"), url);
  assert.ok(url === `/sessions/s1?node=node_1` || url === `/sessions/s1?node=node_1&apps=${appId}`, url);
}
// Only reviewer-notes hints may target the Apps sheet.
assert.equal(notificationLink({ ...base, kind: "session_done", apps: { appId } }).url, "/sessions/s1?node=node_1");
const done = notificationLink({ ...base, kind: "session_done", review: { reviewId: `review-${"b".repeat(16)}` }, attentionId: "q 1" });
assert.deepEqual(done, { url: `/sessions/s1?node=node_1&attention=q%201&review=review-${"b".repeat(16)}`, review: true });
assert.equal(notificationLink({ ...base, kind: "session_done", review: { reviewId: "review-x" } }).review, false);
// Every link the hint route builds stays openable on iOS, reduced to the session.
for (const kind of ["app_notes", "session_done"]) {
  const { url } = notificationLink({ ...base, kind, apps: { appId }, review: { reviewId: `review-${"b".repeat(16)}` }, attentionId: "q_1" });
  assert.equal(nativePushPayload({ url }).url, "/sessions/s1?node=node_1");
}
console.log("notification link checks passed");
