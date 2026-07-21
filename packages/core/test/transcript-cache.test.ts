// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { createTranscriptCache } from "../src/transcript-cache.js";

// The node test env has no IndexedDB. The cache must degrade to a no-op so
// callers never need to feature-detect — get() resolves null, writes are silent.
describe("transcript cache (no IndexedDB available)", () => {
  it("degrades to a no-op instead of throwing", async () => {
    const cache = createTranscriptCache({ indexedDB: undefined });
    await expect(cache.get("s1")).resolves.toBeNull();
    await expect(cache.put("s1", [{ role: "user", content: "hi" }], 1, "h1")).resolves.toBeUndefined();
    await expect(cache.delete("s1")).resolves.toBeUndefined();
    // Still null after a write, since there's no backing store.
    await expect(cache.get("s1")).resolves.toBeNull();
  });

  it("ignores puts without a history hash (never caches a partial prefix)", async () => {
    const cache = createTranscriptCache({ indexedDB: undefined });
    await expect(cache.put("s1", [], 0, "")).resolves.toBeUndefined();
  });
});
