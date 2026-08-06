// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createEphemeralModelKeyStore, memoryBackend } from "../src/index.js";

describe("ephemeral model-key store (device-held seeds)", () => {
  it("stores keys per provider, normalizes ids, and lists metadata without secrets", async () => {
    const store = createEphemeralModelKeyStore(memoryBackend());

    expect(await store.list()).toEqual([]);
    expect(await store.entries()).toEqual([]);

    // Provider ids are normalized (trimmed + lower-cased).
    await store.set("  Anthropic ", "sk-ant-123");
    await store.set("openai", "sk-oai-456");

    expect(await store.get("anthropic")).toBe("sk-ant-123");
    expect(await store.get("ANTHROPIC")).toBe("sk-ant-123");

    // list() is UI-facing metadata only — no key material, sorted by provider.
    const listed = await store.list();
    expect(listed).toEqual([
      { provider: "anthropic", configured: true, updatedAt: expect.any(String) },
      { provider: "openai", configured: true, updatedAt: expect.any(String) },
    ]);
    expect(JSON.stringify(listed)).not.toContain("sk-ant-123");

    // entries() carries the secrets, for seeding a node.
    const entries = await store.entries();
    expect(entries).toEqual(
      expect.arrayContaining([
        { provider: "anthropic", key: "sk-ant-123" },
        { provider: "openai", key: "sk-oai-456" },
      ]),
    );
  });

  it("upserts, rejects empties, and removes", async () => {
    const store = createEphemeralModelKeyStore(memoryBackend());

    await store.set("anthropic", "first");
    await store.set("anthropic", "second"); // overwrite, not duplicate
    expect(await store.get("anthropic")).toBe("second");
    expect(await store.list()).toHaveLength(1);

    await expect(store.set("anthropic", "  ")).rejects.toThrow();
    await expect(store.set("", "key")).rejects.toThrow();

    await store.remove("anthropic");
    expect(await store.get("anthropic")).toBe("");
    expect(await store.list()).toEqual([]);
    // Removing an unknown provider is a no-op.
    await expect(store.remove("ghost")).resolves.toBeUndefined();
  });

  it("persists across store instances on the same backend (real IDB)", async () => {
    const a = createEphemeralModelKeyStore();
    await a.set("anthropic", "sk-persist");
    const b = createEphemeralModelKeyStore();
    expect(await b.get("anthropic")).toBe("sk-persist");
    await b.remove("anthropic");
  });
});
