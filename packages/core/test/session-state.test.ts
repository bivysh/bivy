// SPDX-License-Identifier: MIT
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

describe("re-offered notices", () => {
  it("shows a notice the node sends again (open + history replay) once", () => {
    const store = new SessionStore();
    const offer = { type: "session.notice", message: "Claude Code reached its usage limit.", actions: ["fork", "retry-at-reset:2026-11-06T18:30:00Z"] };
    store.apply(offer as never);
    store.apply(offer as never);
    store.apply({ ...offer, actions: ["fork"] } as never);
    expect(store.getState().activeSession.transcript.map((e) => e.actions)).toEqual([offer.actions, ["fork"]]);
  });
});
