// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Gap 1 visibility: a torn-down destroy-lane session is re-added to the sidebar
// from its durable correlation, flagged `rebuildable`, so it stays openable and a
// send can rebuild it. The flag must NOT stick once the session is live again.
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/index.js";

describe("rebuildable session flag", () => {
  it("preserves an explicit rebuildable flag through normalization", () => {
    const store = new SessionStore();
    store.setSessions([{ sessionId: "s1", nodeId: "eph-1", name: "Rebuildable", rebuildable: true }]);
    expect(store.getState().sessionIndex.sessions.find((s) => s.sessionId === "s1")?.rebuildable).toBe(true);
  });

  it("clears the flag when the session reappears live (no flag on the row)", () => {
    const store = new SessionStore();
    store.setSessions([{ sessionId: "s1", nodeId: "eph-1", name: "X", rebuildable: true }]);
    // The machine rebuilt: the session is back in the live list, without the flag.
    store.setSessions([{ sessionId: "s1", nodeId: "eph-1", name: "X" }]);
    expect(store.getState().sessionIndex.sessions.find((s) => s.sessionId === "s1")?.rebuildable).toBeUndefined();
  });

  it("a normal live session is never rebuildable", () => {
    const store = new SessionStore();
    store.setSessions([{ sessionId: "s2", nodeId: "node-a", name: "Live" }]);
    expect(store.getState().sessionIndex.sessions.find((s) => s.sessionId === "s2")?.rebuildable).toBeUndefined();
  });
});
