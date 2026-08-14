// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/index.js";

const awaiting = {
  transport: "reachable",
  process: "alive",
  agent: "awaiting-input",
  workspace: "dirty",
  displayStatus: "needs_attention",
} as const;

describe("explicit session state", () => {
  it("uses the state-machine projection ahead of legacy status fields", () => {
    const store = new SessionStore();
    store.apply({
      type: "sessions.list",
      sessions: [{ sessionId: "s1", name: "Session", status: "working", isStreaming: true, sessionState: awaiting }],
    } as never);

    expect(store.getState().sessionIndex.sessions[0]).toMatchObject({
      status: "needs_action",
      needsAction: true,
      sessionState: awaiting,
    });
  });

  it("keeps a closed row saved even when its archival envelope has idle axes", () => {
    const store = new SessionStore();
    store.apply({
      type: "sessions.list",
      sessions: [{ sessionId: "s1", name: "Session", status: "saved", open: false, bivySession: { state: { ...awaiting, agent: "idle", displayStatus: "idle" } } }],
    } as never);

    expect(store.getState().sessionIndex.sessions[0]).toMatchObject({ status: "saved" });
    expect(store.getState().sessionIndex.sessions[0]?.sessionState).toBeUndefined();
  });

  it("folds axis-only transitions onto an existing row", () => {
    const store = new SessionStore();
    store.apply({ type: "sessions.list", sessions: [{ sessionId: "s1", name: "Session", status: "idle" }] } as never);
    store.apply({ type: "session.state", sessionId: "s1", state: awaiting } as never);

    expect(store.getState().sessionIndex.sessions[0]).toMatchObject({
      status: "needs_action",
      needsAction: true,
      sessionState: awaiting,
    });
  });
});
