// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { ApprovalManager } from "../src/approval.js";

function ask(mgr: ApprovalManager, sessionId: string) {
  // Fire a request but don't await — it stays pending until resolved/cancelled.
  return mgr.request({ sessionId, toolName: "Bash", toolInput: { cmd: "x" }, reason: "test" });
}

test("cancelForSession denies only that session's pending approvals", async () => {
  const mgr = new ApprovalManager();
  const a = ask(mgr, "s1");
  const b = ask(mgr, "s2");
  mgr.cancelForSession("s1");
  assert.equal(await a, false, "s1 approval must resolve to denied");
  // s2 is untouched and still pending; resolve it explicitly to finish the test.
  const pendingIds = mgr.list().filter((r) => r.status === "pending").map((r) => r.id);
  assert.equal(pendingIds.length, 1, "s2 approval must remain pending");
  mgr.resolve(pendingIds[0], true);
  assert.equal(await b, true);
});

test("history is bounded (does not grow without limit)", () => {
  const mgr = new ApprovalManager();
  for (let i = 0; i < 500; i++) {
    void mgr.request({ sessionId: `s${i}`, toolName: "Bash", toolInput: {}, reason: "r" });
  }
  mgr.resolveAll(true); // moves all 500 into history
  const history = mgr.list();
  assert.ok(history.length <= 200, `history should be capped at 200, got ${history.length}`);
});
