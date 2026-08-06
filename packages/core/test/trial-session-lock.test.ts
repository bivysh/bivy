// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/index.js";

describe("hosted trial session locks", () => {
  it("keeps an account-index lock across a later node sessions.list refresh", () => {
    const store = new SessionStore();
    store.setSessions([{ sessionId: "s26", nodeId: "node-a", name: "Locked session", locked: true }]);

    store.apply({ type: "sessions.list", sessions: [{ id: "s26", nodeId: "node-a", name: "private title" }] });

    expect(store.getState().sessions[0]?.locked).toBe(true);
    expect(store.getState().sessions[0]?.name).toBe("Locked session");
    expect(store.getState().sessions[0]?.path).toBeUndefined();
  });

  it("clears the lock when a fresh account index explicitly unlocks it", () => {
    const store = new SessionStore();
    store.setSessions([{ sessionId: "s26", nodeId: "node-a", name: "Locked session", locked: true }]);

    store.setSessions([{ sessionId: "s26", nodeId: "node-a", name: "Visible again", locked: false }]);

    expect(store.getState().sessions[0]?.locked).toBeUndefined();
    expect(store.getState().sessions[0]?.name).toBe("Visible again");
  });
});
