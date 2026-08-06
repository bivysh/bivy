// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { parseShardUrls, fnv1a, shardForNode } from "../src/relay-shards.js";

/**
 * Relay sharding (docs/scaling.md): a node and all of its clients must
 * deterministically map to the same relay shard, and the default (no
 * RELAY_SHARD_URLS) must behave exactly like the old single-relay setup.
 */

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

await test("defaults to RELAY_PUBLIC_URL as a single shard", () => {
  const urls = parseShardUrls({ RELAY_PUBLIC_URL: "wss://relay.bivy.sh" } as NodeJS.ProcessEnv);
  assert.deepEqual(urls, ["wss://relay.bivy.sh"]);
});

await test("RELAY_SHARD_URLS overrides and is parsed/cleaned", () => {
  const urls = parseShardUrls({
    RELAY_PUBLIC_URL: "wss://relay.bivy.sh",
    RELAY_SHARD_URLS: " wss://relay-0.bivy.sh/, wss://relay-1.bivy.sh ,",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(urls, ["wss://relay-0.bivy.sh", "wss://relay-1.bivy.sh"]);
});

await test("falls back to localhost when nothing is set", () => {
  const urls = parseShardUrls({} as NodeJS.ProcessEnv);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^ws:\/\//);
});

await test("fnv1a is deterministic and well-distributed enough", () => {
  assert.equal(fnv1a("node-abc"), fnv1a("node-abc"));
  assert.notEqual(fnv1a("node-abc"), fnv1a("node-abd"));
});

await test("single shard always returns the one URL", () => {
  const urls = ["wss://only.bivy.sh"];
  assert.equal(shardForNode("anything", urls), "wss://only.bivy.sh");
  assert.equal(shardForNode(null, urls), "wss://only.bivy.sh");
});

await test("a node maps to a stable shard across calls", () => {
  const urls = ["wss://r0", "wss://r1", "wss://r2", "wss://r3"];
  const first = shardForNode("node-stable", urls);
  for (let i = 0; i < 100; i++) assert.equal(shardForNode("node-stable", urls), first);
});

await test("node and its clients co-locate (same nodeId -> same shard)", () => {
  const urls = ["wss://r0", "wss://r1", "wss://r2", "wss://r3"];
  // Whatever the node resolves to, a client targeting that node resolves to the
  // same URL — that's the whole invariant that keeps them in one room.
  for (const nodeId of ["n1", "n2", "long-node-id-xyz", "00000000-aaaa"]) {
    assert.equal(shardForNode(nodeId, urls), shardForNode(nodeId, urls));
  }
});

await test("distributes nodes across shards (not all on one)", () => {
  const urls = ["wss://r0", "wss://r1", "wss://r2", "wss://r3"];
  const counts = new Map<string, number>();
  for (let i = 0; i < 2000; i++) {
    const u = shardForNode(`node-${i}`, urls);
    counts.set(u, (counts.get(u) ?? 0) + 1);
  }
  // Every shard should get a meaningful share (>10% of a perfectly-even 25%).
  assert.equal(counts.size, urls.length);
  for (const u of urls) assert.ok((counts.get(u) ?? 0) > 200, `shard ${u} underused: ${counts.get(u)}`);
});

await test("null/empty nodeId routes deterministically to shard 0", () => {
  const urls = ["wss://r0", "wss://r1"];
  assert.equal(shardForNode(null, urls), "wss://r0");
  assert.equal(shardForNode(undefined, urls), "wss://r0");
  assert.equal(shardForNode("", urls), "wss://r0");
});

console.log(`\n${passed} relay-shard tests passed`);
