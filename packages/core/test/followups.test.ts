// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Queued follow-ups (issue #154): the pure decision helpers (followups.ts)
// and SessionStore's CRUD over AppState.followupsBySession. AppController
// (packages/web) orchestrates *when* these are called (busy-gating, dispatch,
// retry-on-reconnect) — see its own doc comments — but the state machine and
// its edge cases (stale edits, attachment survival, duplicate-ack safety) all
// live here, where they're directly testable.
import { describe, expect, it } from "vitest";
import { SessionStore, mustQueueFollowup, nextQueuedFollowup, supportsSteering, type PendingFollowup, type PromptAttachment } from "../src/index.js";

describe("mustQueueFollowup", () => {
  it("does not queue an idle session with nothing already waiting", () => {
    expect(mustQueueFollowup(0, false)).toBe(false);
  });
  it("queues while the session is mid-turn", () => {
    expect(mustQueueFollowup(0, true)).toBe(true);
  });
  it("queues behind earlier items even once the session goes idle — never jumps the line", () => {
    expect(mustQueueFollowup(2, false)).toBe(true);
  });
});

describe("supportsSteering", () => {
  it("is false with no capabilities at all", () => {
    expect(supportsSteering(undefined)).toBe(false);
    expect(supportsSteering(null)).toBe(false);
  });
  it("is false when streamingBehaviors is absent, empty, or malformed", () => {
    expect(supportsSteering({})).toBe(false);
    expect(supportsSteering({ streamingBehaviors: [] })).toBe(false);
    expect(supportsSteering({ streamingBehaviors: "steer" })).toBe(false);
  });
  it("is false when only followUp is advertised (Pi's queue-only mode, or a shim that never promised steer)", () => {
    expect(supportsSteering({ streamingBehaviors: ["followUp"] })).toBe(false);
  });
  it("is true when steer is advertised, alongside other values", () => {
    expect(supportsSteering({ streamingBehaviors: ["steer"] })).toBe(true);
    expect(supportsSteering({ streamingBehaviors: ["followUp", "steer"] })).toBe(true);
  });
});

describe("nextQueuedFollowup", () => {
  const mk = (id: string, status: PendingFollowup["status"]): PendingFollowup => ({
    id,
    text: id,
    status,
    createdAt: 0,
    updatedAt: 0,
    version: 1,
  });

  it("returns the first queued item, in order", () => {
    const items = [mk("a", "queued"), mk("b", "queued")];
    expect(nextQueuedFollowup(items)?.id).toBe("a");
  });
  it("skips items already sending/sent/failed ahead of a later queued one", () => {
    const items = [mk("a", "sending"), mk("b", "queued")];
    expect(nextQueuedFollowup(items)?.id).toBe("b");
  });
  it("returns undefined when nothing is queued", () => {
    expect(nextQueuedFollowup([mk("a", "sending")])).toBeUndefined();
    expect(nextQueuedFollowup([])).toBeUndefined();
  });
});

describe("SessionStore queued follow-ups", () => {
  const img: PromptAttachment = { kind: "image", name: "shot.png", size: 10, mimeType: "image/png", data: "aGk=" };

  it("starts empty for a session with nothing queued", () => {
    const store = new SessionStore();
    expect(store.getFollowups("s1")).toEqual([]);
  });

  it("enqueues in order and preserves attachments", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one", attachments: [img] }, 1000);
    store.enqueueFollowup("s1", { id: "f2", text: "two" }, 1001);
    store.enqueueFollowup("s1", { id: "f3", text: "three" }, 1002);
    const items = store.getFollowups("s1");
    expect(items.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
    expect(items[0]!.attachments).toEqual([img]);
    expect(items[0]!.status).toBe("queued");
    expect(items[0]!.version).toBe(1);
  });

  it("ignores a duplicate enqueue of an id already present (no double entry)", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one" }, 1000);
    store.enqueueFollowup("s1", { id: "f1", text: "one (retry)" }, 1001);
    expect(store.getFollowups("s1")).toHaveLength(1);
    expect(store.getFollowups("s1")[0]!.text).toBe("one");
  });

  it("three follow-ups can be reordered and drain in the displayed order (acceptance: reorder + delivery order)", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one" }, 1000);
    store.enqueueFollowup("s1", { id: "f2", text: "two" }, 1001);
    store.enqueueFollowup("s1", { id: "f3", text: "three" }, 1002);
    // Move "three" to the front.
    expect(store.reorderFollowup("s1", "f3", 0)).toBe(true);
    expect(store.getFollowups("s1").map((f) => f.id)).toEqual(["f3", "f1", "f2"]);
    // Move "one" to the back.
    expect(store.reorderFollowup("s1", "f1", 2)).toBe(true);
    expect(store.getFollowups("s1").map((f) => f.id)).toEqual(["f3", "f2", "f1"]);

    // Simulate the controller's drain loop: dispatch the front queued item,
    // confirm it, repeat — exactly mirrors dispatchFollowup + the
    // session.user_message ack path.
    const delivered: string[] = [];
    for (let i = 0; i < 3; i++) {
      const next = nextQueuedFollowup(store.getFollowups("s1"));
      expect(next).toBeDefined();
      store.markFollowupSending("s1", next!.id, 2000 + i);
      delivered.push(next!.id);
      store.confirmFollowupSent("s1", next!.id);
    }
    expect(delivered).toEqual(["f3", "f2", "f1"]);
    expect(store.getFollowups("s1")).toEqual([]);
  });

  it("reordering an item that's already dispatched is a no-op", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one" }, 1000);
    store.enqueueFollowup("s1", { id: "f2", text: "two" }, 1001);
    store.markFollowupSending("s1", "f1", 1002);
    expect(store.reorderFollowup("s1", "f1", 1)).toBe(false);
    expect(store.getFollowups("s1").map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("edits a queued item's text and attachments, bumping its version", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one", attachments: [img] }, 1000);
    const result = store.editFollowup("s1", "f1", { text: "one (edited)", attachments: [] }, 1, 1001);
    expect(result).toEqual({ ok: true, item: expect.objectContaining({ id: "f1", text: "one (edited)", version: 2 }) });
    const item = store.getFollowups("s1")[0]!;
    expect(item.text).toBe("one (edited)");
    expect(item.attachments).toEqual([]);
    expect(item.version).toBe(2);
  });

  it("preserves attachments through an edit that only changes text", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one", attachments: [img] }, 1000);
    store.editFollowup("s1", "f1", { text: "one (edited)", attachments: [img] }, 1, 1001);
    expect(store.getFollowups("s1")[0]!.attachments).toEqual([img]);
  });

  it("rejects a stale edit (version mismatch) rather than silently overwriting", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one" }, 1000);
    // A first edit succeeds and bumps the version to 2...
    const first = store.editFollowup("s1", "f1", { text: "one (edit A)" }, 1, 1001);
    expect(first.ok).toBe(true);
    // ...a second caller (a stale composer, or another tab) still holds
    // version 1 and must be rejected, not overwrite edit A.
    const stale = store.editFollowup("s1", "f1", { text: "one (edit B, stale)" }, 1, 1002);
    expect(stale).toEqual({ ok: false, reason: "stale" });
    expect(store.getFollowups("s1")[0]!.text).toBe("one (edit A)");
  });

  it("rejects editing an item that's already dispatched", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one" }, 1000);
    store.markFollowupSending("s1", "f1", 1001);
    const result = store.editFollowup("s1", "f1", { text: "too late" }, 1, 1002);
    expect(result).toEqual({ ok: false, reason: "not_queued" });
  });

  it("rejects editing an item that no longer exists", () => {
    const store = new SessionStore();
    const result = store.editFollowup("s1", "ghost", { text: "x" }, 1, 1000);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("removing a queued item changes what the agent would receive (acceptance: removal)", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one" }, 1000);
    store.enqueueFollowup("s1", { id: "f2", text: "two" }, 1001);
    expect(store.removeFollowup("s1", "f1")).toBe(true);
    expect(store.getFollowups("s1").map((f) => f.id)).toEqual(["f2"]);
  });

  it("does not remove an item that's already dispatched", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one" }, 1000);
    store.markFollowupSending("s1", "f1", 1001);
    expect(store.removeFollowup("s1", "f1")).toBe(false);
    expect(store.getFollowups("s1")).toHaveLength(1);
  });

  it("confirming delivery drops the item, and a duplicate ack for the same id is a safe no-op (acceptance: duplicate suppression)", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one" }, 1000);
    store.markFollowupSending("s1", "f1", 1001);
    store.confirmFollowupSent("s1", "f1");
    expect(store.getFollowups("s1")).toEqual([]);
    // A second, duplicate session.user_message echo (e.g. a retried send that
    // actually did land twice at the wire level) must not throw or resurrect it.
    expect(() => store.confirmFollowupSent("s1", "f1")).not.toThrow();
    expect(store.getFollowups("s1")).toEqual([]);
  });

  it("reverts an unconfirmed send back to the FRONT of the queue on reconnect, preserving order (acceptance: reconnect)", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one" }, 1000);
    store.enqueueFollowup("s1", { id: "f2", text: "two" }, 1001);
    // f1 dispatched, but the socket drops before any ack arrives.
    store.markFollowupSending("s1", "f1", 1002);
    expect(store.getFollowups("s1").map((f) => f.status)).toEqual(["sending", "queued"]);
    // Reconnect: could not confirm delivery, so it's queued again — at the
    // front, so a retry still goes out before f2 rather than behind it.
    store.revertFollowupToQueued("s1", "f1", 2000);
    const items = store.getFollowups("s1");
    expect(items.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(items[0]!.status).toBe("queued");
  });

  it("settles (drops) a still-sending item once its turn provably completed, even with no explicit ack (durable-equivalent acknowledgement)", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one" }, 1000);
    store.enqueueFollowup("s1", { id: "f2", text: "two" }, 1001);
    store.markFollowupSending("s1", "f1", 1002);
    // agent_end fires for the turn f1 started, but its session.user_message
    // echo never arrived (lost in a reconnect window).
    store.settleSendingFollowups("s1");
    expect(store.getFollowups("s1").map((f) => f.id)).toEqual(["f2"]);
  });

  it("keeps other sessions' queues isolated", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one" }, 1000);
    store.enqueueFollowup("s2", { id: "g1", text: "other session" }, 1000);
    expect(store.getFollowups("s1").map((f) => f.id)).toEqual(["f1"]);
    expect(store.getFollowups("s2").map((f) => f.id)).toEqual(["g1"]);
  });

  it("drops a session's queue entirely on session.deleted", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one" }, 1000);
    store.apply({ type: "session.deleted", sessionId: "s1" });
    expect(store.getFollowups("s1")).toEqual([]);
  });

  it("clears every session's queue on resetSession (node switch)", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one" }, 1000);
    store.resetSession();
    expect(store.getFollowups("s1")).toEqual([]);
  });
});

describe("scheduled-message backstop bookkeeping (scheduledAutomationId)", () => {
  it("records the control-plane automation on a fresh enqueue", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one", scheduledAutomationId: "auto-1" }, 1000);
    expect(store.getFollowups("s1")[0]!.scheduledAutomationId).toBe("auto-1");
  });

  it("attachFollowupAutomation links a queued item, and only a queued item", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one" }, 1000);
    expect(store.attachFollowupAutomation("s1", "f1", "auto-1")).toBe(true);
    expect(store.getFollowups("s1")[0]!.scheduledAutomationId).toBe("auto-1");
    // A ghost id or a dispatched item is refused so the caller cancels the
    // automation (the item no longer needs the backstop).
    expect(store.attachFollowupAutomation("s1", "ghost", "auto-x")).toBe(false);
    store.markFollowupSending("s1", "f1", 1001);
    expect(store.attachFollowupAutomation("s1", "f1", "auto-2")).toBe(false);
  });

  it("dropping the item clears its backstop id", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one", scheduledAutomationId: "auto-1" }, 1000);
    expect(store.removeFollowup("s1", "f1")).toBe(true);
    expect(store.getFollowups("s1")).toEqual([]);
  });

  it("an edit clears the stale automation id so the controller re-creates it for the new text", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one", scheduledAutomationId: "auto-1" }, 1000);
    const result = store.editFollowup("s1", "f1", { text: "edited" }, 1, 1001);
    expect(result.ok).toBe(true);
    expect(store.getFollowups("s1")[0]!.scheduledAutomationId).toBeUndefined();
    expect(store.getFollowups("s1")[0]!.text).toBe("edited");
  });

  it("confirming delivery drops the item and its backstop id (no stale handle to cancel)", () => {
    const store = new SessionStore();
    store.enqueueFollowup("s1", { id: "f1", text: "one", scheduledAutomationId: "auto-1" }, 1000);
    store.markFollowupSending("s1", "f1", 1001);
    store.confirmFollowupSent("s1", "f1");
    expect(store.getFollowups("s1")).toEqual([]);
  });
});

describe("scheduled-message queue rows (long-press Send → ScheduleSheet)", () => {
  it("enqueueScheduledFollowup records a scheduled row; the row id IS the automation id", () => {
    const store = new SessionStore();
    const row = store.enqueueScheduledFollowup("s1", { id: "auto-1", text: "remind me", scheduledAt: 5000, scheduledAutomationId: "auto-1" }, 1000);
    expect(row.status).toBe("scheduled");
    expect(row.scheduledAt).toBe(5000);
    expect(row.scheduledAutomationId).toBe("auto-1");
    // Duplicate id is ignored (the sheet may be re-submitted for the same
    // automation), matching enqueueFollowup.
    store.enqueueScheduledFollowup("s1", { id: "auto-1", text: "changed", scheduledAt: 6000, scheduledAutomationId: "auto-1" }, 1001);
    expect(store.getFollowups("s1")).toHaveLength(1);
    expect(store.getFollowups("s1")[0]!.text).toBe("remind me");
  });

  it("scheduled rows can be removed (cancelled) like queued rows", () => {
    const store = new SessionStore();
    store.enqueueScheduledFollowup("s1", { id: "auto-1", text: "remind me", scheduledAt: 5000, scheduledAutomationId: "auto-1" }, 1000);
    expect(store.removeFollowup("s1", "auto-1")).toBe(true);
    expect(store.getFollowups("s1")).toEqual([]);
  });

  it("rescheduleFollowup moves the fire time in place and bumps the version", () => {
    const store = new SessionStore();
    store.enqueueScheduledFollowup("s1", { id: "auto-1", text: "remind me", scheduledAt: 5000, scheduledAutomationId: "auto-1" }, 1000);
    expect(store.rescheduleFollowup("s1", "auto-1", 9000, 2000)).toBe(true);
    const row = store.getFollowups("s1")[0]!;
    expect(row.scheduledAt).toBe(9000);
    expect(row.version).toBe(2);
    expect(row.scheduledAutomationId).toBe("auto-1");
  });

  it("rescheduleFollowup refuses rows that are no longer scheduled", () => {
    const store = new SessionStore();
    store.enqueueScheduledFollowup("s1", { id: "auto-1", text: "remind me", scheduledAt: 5000, scheduledAutomationId: "auto-1" }, 1000);
    store.removeFollowup("s1", "auto-1");
    expect(store.rescheduleFollowup("s1", "auto-1", 9000, 2000)).toBe(false);
    // A queued (drain-eligible) row is not a scheduled row either.
    store.enqueueFollowup("s1", { id: "f1", text: "one" }, 1000);
    expect(store.rescheduleFollowup("s1", "f1", 9000, 2000)).toBe(false);
  });

  it("pruneScheduledFollowups drops only rows whose automation is gone, keeping others", () => {
    const store = new SessionStore();
    store.enqueueScheduledFollowup("s1", { id: "auto-1", text: "one", scheduledAt: 5000, scheduledAutomationId: "auto-1" }, 1000);
    store.enqueueScheduledFollowup("s1", { id: "auto-2", text: "two", scheduledAt: 6000, scheduledAutomationId: "auto-2" }, 1001);
    store.enqueueFollowup("s1", { id: "f1", text: "queued", scheduledAutomationId: "auto-q" }, 1002);
    // auto-2 fired/gone; auto-1 still pending.
    store.pruneScheduledFollowups("s1", new Set(["auto-1"]));
    const rows = store.getFollowups("s1");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(["auto-1", "f1"]);
  });
});
