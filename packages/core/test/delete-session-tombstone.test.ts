// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Deleting a session from the web app optimistically drops the row, but then
// immediately re-fetches the control-plane session index — which lags the
// node's debounced, best-effort advert. Without a tombstone that stale list
// resurrects the just-deleted row and the delete looks like it silently failed.
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/index.js";

describe("delete-session tombstone", () => {
  it("suppresses a just-deleted session that a stale full-list refresh re-adds", () => {
    const store = new SessionStore();
    store.setSessions([
      { sessionId: "s1", nodeId: "node-a", name: "One" },
      { sessionId: "s2", nodeId: "node-a", name: "Two" },
    ]);

    // User deletes s1 — optimistic removal.
    store.removeSessionLocal("s1");
    expect(store.getState().sessionIndex.sessions.map((s) => s.sessionId)).toEqual(["s2"]);

    // A refresh reads the still-stale control-plane index that includes s1.
    store.setSessions([
      { sessionId: "s1", nodeId: "node-a", name: "One" },
      { sessionId: "s2", nodeId: "node-a", name: "Two" },
    ]);
    // s1 must stay gone.
    expect(store.getState().sessionIndex.sessions.map((s) => s.sessionId)).toEqual(["s2"]);
  });

  it("restores a tombstone across a PWA reload", () => {
    const first = new SessionStore();
    first.setSessions([{ sessionId: "s1", nodeId: "node-a", name: "One" }]);
    first.removeSessionLocal("s1");

    const reloaded = new SessionStore();
    reloaded.seedDeletedSessionTombstones(first.deletedSessionTombstones());
    reloaded.seedSessions([{ sessionId: "s1", nodeId: "node-a", name: "One" }]);
    expect(reloaded.getState().sessionIndex.sessions).toEqual([]);
  });

  it("ignores a late creation broadcast without hiding unrelated sessions", () => {
    const store = new SessionStore();
    store.removeSessionLocal("s1");
    store.apply({ type: "session.created", sessionId: "s1" });
    store.apply({ type: "session.created", sessionId: "s2" });
    expect(store.getState().sessionIndex.sessions.map(s => s.sessionId)).toEqual(["s2"]);
  });

  it("does not restore or complete a dismissed cloud startup", () => {
    const store = new SessionStore();
    store.persistPendingSession("starting-1", "Test");
    store.dismissPendingSession("starting-1");
    store.completePendingSession("starting-1", "canonical-1", "eph-1");
    expect(store.getState().sessionIndex.sessions).toEqual([]);
    const reloaded = new SessionStore();
    reloaded.seedDeletedSessionTombstones(store.deletedSessionTombstones());
    reloaded.persistPendingSession("starting-1", "Test");
    expect(reloaded.getState().sessionIndex.sessions).toEqual([]);
    expect(reloaded.getState().activeSession.activeSessionId).toBeNull();
  });

  it("applies restored deletion intent to rows already in memory", () => {
    const store = new SessionStore();
    store.setSessions([{ sessionId: "s1" }]);
    store.seedDeletedSessionTombstones({ s1: 1 });
    expect(store.getState().sessionIndex.sessions).toEqual([]);
  });

  it("tombstones a session.deleted broadcast so a stale refresh cannot resurrect a pruned session", () => {
    const store = new SessionStore();
    store.setSessions([{ sessionId: "s1", nodeId: "node-a", name: "One" }]);
    store.apply({ type: "session.deleted", sessionId: "s1" });
    store.setSessions([{ sessionId: "s1", nodeId: "node-a", name: "One" }]);
    expect(store.getState().sessionIndex.sessions).toEqual([]);
  });

  it("keeps offline ephemeral records deleted after months and a reload", () => {
    const store = new SessionStore();
    const realNow = Date.now;
    try {
      let now = 1_000_000;
      Date.now = () => now;
      store.setSessions([{ sessionId: "s1", nodeId: "node-a", name: "One" }]);
      store.removeSessionLocal("s1");
      now += 180 * 24 * 60 * 60_000;
      const stale = [{ sessionId: "s1", nodeId: "eph-retired", name: "One", rebuildable: true }];
      store.setSessions(stale);
      expect(store.getState().sessionIndex.sessions).toEqual([]);
      const reloaded = new SessionStore();
      reloaded.seedDeletedSessionTombstones(store.deletedSessionTombstones());
      reloaded.seedSessions(stale);
      reloaded.apply({ type: "sessions.list", sessions: stale });
      reloaded.apply({ type: "session.created", sessionId: "s1" });
      expect(reloaded.getState().sessionIndex.sessions).toEqual([]);
      expect(reloaded.isSessionDeleted("s1")).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });
});
