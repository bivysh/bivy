import assert from "node:assert/strict";
import { attentionRank, isUnseen, statusClass, statusLabel } from "../packages/web/src/sessionStatus.js";

assert.equal(statusClass({ status: "working" }), "working");
assert.equal(statusClass({ status: "failed" }), "failed");
assert.equal(statusLabel({ status: "failed" }), "Last turn failed");
assert.equal(isUnseen({ status: "idle", finishedAt: 20, lastSeenAt: 10 }), true);
assert.equal(attentionRank({ status: "idle", finishedAt: 20, lastSeenAt: 10 }), 1);
assert.equal(attentionRank({ status: "failed" }), 2);
assert.equal(attentionRank({ status: "needs_action" }), 3);

console.log("session-status-semantics: all tests passed");
