// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// PWA safety invariants that live in pure state and coordinator logic. The ones
// that need the rendered UI (full-access and billable confirmations, Stop,
// attention focus, template review) are in test/browser/safety-confirmations.
import assert from "node:assert/strict";
import test from "node:test";

test("failed ephemeral machines are retained only by an explicit debug build opt-in", async () => {
  // Retaining a boot-failed machine keeps a billable resource alive; production
  // builds (no VITE_BIVY_KEEP_FAILED_EPHEMERAL=1) must never do it.
  const { EPHEMERAL_KEEP_FAILED_MACHINES } = await import("../packages/web/src/flags.js");
  assert.equal(EPHEMERAL_KEEP_FAILED_MACHINES, false);
});

test("browser-node credential sync keeps an offline key rotation and honors newer deletions", async () => {
  const { CredentialsModelsCoordinator } = await import("../packages/web/src/store/coordinators/credentials-models-coordinator.js");
  type Key = { provider: string; label: string; key: string; updatedAt?: string | null };
  let browser: Key[] = [
    // Rotated in this browser while the node was offline: newer than the node's copy.
    { provider: "anthropic", label: "default", key: "rotated-locally", updatedAt: "2026-09-02T00:00:00Z" },
    // Deleted on the node after this browser last saw it.
    { provider: "openai", label: "default", key: "old-openai", updatedAt: "2026-09-01T00:00:00Z" },
    // The node now holds an OAuth login under this name; the browser API key must yield.
    { provider: "xai", label: "default", key: "xai-key", updatedAt: "2026-09-01T00:00:00Z" },
  ];
  const pushed: Array<{ provider: string; key: string }> = [];
  const coordinator = new CredentialsModelsCoordinator({
    send: () => {},
    awaitAck: async (command) => {
      const c = command as { kind: string; provider?: string; key?: string };
      if (c.kind === "credential.set") pushed.push({ provider: c.provider!, key: c.key! });
      if (c.kind !== "credentials.account.export") return {} as never;
      return {
        entries: [
          { provider: "anthropic", label: "default", key: "stale-on-node", updatedAt: Date.parse("2026-09-01T00:00:00Z") },
          { provider: "google", label: "default", key: "new-from-node", updatedAt: Date.parse("2026-09-01T00:00:00Z") },
        ],
        records: [{ provider: "xai", label: "default", kind: "oauth" }],
        deletedAt: { openai: Date.parse("2026-09-03T00:00:00Z") },
      } as never;
    },
    rememberModel: () => {},
    selectModelLocally: () => {},
    isDirect: () => true, // sync must also run for a direct (LAN) connection
    now: () => Date.parse("2026-09-04T00:00:00Z"),
    isOnline: () => true,
    importModelKeys: async (entries) => {
      for (const e of entries) {
        browser = browser.filter((k) => !(k.provider === e.provider && k.label === (e.label ?? "default")));
        browser.push({ provider: e.provider, label: e.label ?? "default", key: e.key, updatedAt: "2026-09-04T00:00:00Z" });
      }
    },
    removeModelKey: async (provider, label = "default") => { browser = browser.filter((k) => !(k.provider === provider && k.label === label)); },
    accountModelKeys: async () => browser,
    importOAuthCredentials: async () => {},
    removeOAuthCredential: async () => {},
    accountOAuthCredentials: async () => [],
    oauthRecoveryEnabled: () => false,
  });

  await coordinator.syncAccountCredentials();
  const keys = Object.fromEntries(browser.map((k) => [k.provider, k.key]));
  assert.equal(keys.anthropic, "rotated-locally", "a stale node snapshot never overwrites a newer local rotation");
  assert.equal(keys.google, "new-from-node", "keys this browser does not have are imported");
  assert.equal(keys.openai, undefined, "a node deletion newer than the local key removes it");
  assert.equal(keys.xai, undefined, "an API key yields to an OAuth login of the same name on the node");
  assert.ok(pushed.some((p) => p.provider === "anthropic" && p.key === "rotated-locally"), "the local rotation is pushed to the node");
});
