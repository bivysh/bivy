// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/index.js";

// The first-run "sign in to your model" prompt (`needsModelAuth`) is raised by
// the web controller when a launched ephemeral runner comes online with no
// model credentials. These tests cover the store-side lifecycle the UI depends
// on: it starts empty, can be set/cleared, auto-dismisses the moment a provider
// becomes configured (login completed, or a hosted-escrow / peer sync landed),
// and never survives a node switch.
describe("needsModelAuth (first-run subscription-OAuth prompt)", () => {
  it("defaults to null", () => {
    expect(new SessionStore().getState().needsModelAuth).toBeNull();
  });

  it("sets and clears via setNeedsModelAuth", () => {
    const store = new SessionStore();
    store.setNeedsModelAuth({ nodeId: "eph-1", provider: "anthropic" });
    expect(store.getState().needsModelAuth).toEqual({ nodeId: "eph-1", provider: "anthropic" });
    store.setNeedsModelAuth(null);
    expect(store.getState().needsModelAuth).toBeNull();
  });

  it("does NOT dismiss while every provider is still unconfigured", () => {
    const store = new SessionStore();
    store.setNeedsModelAuth({ nodeId: "eph-1", provider: "anthropic" });
    store.apply({
      type: "providers.list",
      providers: [{ id: "anthropic", configured: false, oauth: true }],
    } as never);
    // Creds haven't landed yet — the prompt must stay up, not dead-end the user.
    expect(store.getState().needsModelAuth).toEqual({ nodeId: "eph-1", provider: "anthropic" });
  });

  it("auto-dismisses once any provider becomes configured", () => {
    const store = new SessionStore();
    store.setNeedsModelAuth({ nodeId: "eph-1", provider: "anthropic" });
    store.apply({
      type: "providers.list",
      providers: [{ id: "anthropic", configured: true, oauth: true }],
    } as never);
    expect(store.getState().needsModelAuth).toBeNull();
  });

  it("clears on a node switch (resetSession)", () => {
    const store = new SessionStore();
    store.setNeedsModelAuth({ nodeId: "eph-1", provider: "anthropic" });
    store.resetSession();
    expect(store.getState().needsModelAuth).toBeNull();
  });
});
