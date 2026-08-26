// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/index.js";
import type { EphemeralNodeConfig } from "../src/account.js";

const RUNNER: EphemeralNodeConfig = {
  id: "cfg-1", name: "Fly.io runner", provider: "fly",
  region: "iad", size: "shared-1x-2gb", ttlMinutes: 60, teardownOnAgentFinish: true,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

// `draftEphemeralConfig` is the runner a new session will launch on its first
// message (the controller's sendPrompt reads it). These cover the store-side
// lifecycle the UI depends on: it starts empty, can be picked/cleared, and never
// survives a node switch (resetSession) or a fresh draft (resetActiveSession) —
// so a stale pick can't leak onto an unrelated session.
describe("draftEphemeralConfig (pick-a-runner-then-send)", () => {
  it("defaults to null", () => {
    expect(new SessionStore().getState().draft.ephemeralConfig).toBeNull();
  });

  it("picks and clears via setDraftEphemeralConfig", () => {
    const store = new SessionStore();
    store.setDraftEphemeralConfig(RUNNER);
    expect(store.getState().draft.ephemeralConfig).toEqual(RUNNER);
    store.setDraftEphemeralConfig(null);
    expect(store.getState().draft.ephemeralConfig).toBeNull();
  });

  it("clears on a node switch (resetSession) — e.g. after binding the launched machine", () => {
    const store = new SessionStore();
    store.setDraftEphemeralConfig(RUNNER);
    store.resetSession();
    expect(store.getState().draft.ephemeralConfig).toBeNull();
  });

  it("clears on a fresh draft (resetActiveSession)", () => {
    const store = new SessionStore();
    store.setDraftEphemeralConfig(RUNNER);
    store.resetActiveSession();
    expect(store.getState().draft.ephemeralConfig).toBeNull();
  });

  it("persists a cold-start placeholder before the runner is online", () => {
    const store = new SessionStore();
    store.persistPendingSession("starting-request-1", "Fix the flaky test");

    expect(store.getState().activeSession.activeSessionId).toBe("starting-request-1");
    expect(store.getState().sessionIndex.sessions[0]).toMatchObject({
      sessionId: "starting-request-1",
      name: "Fix the flaky test",
      status: "working",
    });
  });

  it("replaces the placeholder with the canonical node session", () => {
    const store = new SessionStore();
    store.persistPendingSession("starting-request-1", "Fix the flaky test");
    store.completePendingSession("starting-request-1", "session-real", "eph-node");

    expect(store.getState().activeSession.activeSessionId).toBe("session-real");
    expect(store.getState().sessionIndex.sessions).toHaveLength(1);
    expect(store.getState().sessionIndex.sessions[0]).toMatchObject({
      sessionId: "session-real",
      nodeId: "eph-node",
      name: "Fix the flaky test",
      status: "working",
    });
  });

  it("keeps structured startup checkpoints and time-to-first-response across canonical binding", () => {
    const store = new SessionStore();
    store.persistPendingSession("starting-request-1", "Fix the flaky test", true, "Bivy Cloud", 1_000);
    store.updateLaunchCheckpoint("starting-request-1", "account", "done");
    store.updateLaunchCheckpoint("starting-request-1", "capacity", "done");
    store.updateLaunchCheckpoint("starting-request-1", "service", "active");
    store.completePendingSession("starting-request-1", "session-real", "eph-node");
    store.setSessions([{ sessionId: "session-real", name: "Fix the flaky test", nodeId: "eph-node" }]);
    store.markLaunchFirstResponse("session-real", 43_000);

    expect(store.getState().sessionIndex.sessions[0]?.launchProgress).toMatchObject({
      startedAt: 1_000,
      firstResponseAt: 43_000,
      checkpoints: {
        account: { state: "done" },
        capacity: { state: "done" },
        service: { state: "active" },
      },
    });
  });

  it("settles a failed placeholder without losing its intended Machine", () => {
    const store = new SessionStore();
    store.persistPendingSession("starting-request-1", "Fix the flaky test", true, "Bivy Cloud");
    store.failPendingSession("starting-request-1");
    expect(store.getState().sessionIndex.sessions[0]).toMatchObject({ status: "failed", pendingNodeName: "Bivy Cloud" });
  });
});
