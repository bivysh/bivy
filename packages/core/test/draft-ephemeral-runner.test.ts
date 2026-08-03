// SPDX-License-Identifier: FSL-1.1-ALv2
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
    expect(new SessionStore().getState().draftEphemeralConfig).toBeNull();
  });

  it("picks and clears via setDraftEphemeralConfig", () => {
    const store = new SessionStore();
    store.setDraftEphemeralConfig(RUNNER);
    expect(store.getState().draftEphemeralConfig).toEqual(RUNNER);
    store.setDraftEphemeralConfig(null);
    expect(store.getState().draftEphemeralConfig).toBeNull();
  });

  it("clears on a node switch (resetSession) — e.g. after binding the launched machine", () => {
    const store = new SessionStore();
    store.setDraftEphemeralConfig(RUNNER);
    store.resetSession();
    expect(store.getState().draftEphemeralConfig).toBeNull();
  });

  it("clears on a fresh draft (resetActiveSession)", () => {
    const store = new SessionStore();
    store.setDraftEphemeralConfig(RUNNER);
    store.resetActiveSession();
    expect(store.getState().draftEphemeralConfig).toBeNull();
  });
});
