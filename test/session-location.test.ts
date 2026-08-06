// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { InMemorySessionLocationRegistry, type SessionLocation } from "../src/runtime/session-location.js";

const loc = (over: Partial<SessionLocation> = {}): SessionLocation => ({
  sessionId: "s1",
  agentServiceAddress: "unix:/tmp/a.sock",
  runtimeId: "claude-code-sdk",
  ...over,
});

test("record then lookup returns the location", async () => {
  const reg = new InMemorySessionLocationRegistry();
  await reg.record(loc({ nodeId: "node-1" }));
  const found = await reg.lookup("s1");
  assert.equal(found?.agentServiceAddress, "unix:/tmp/a.sock");
  assert.equal(found?.runtimeId, "claude-code-sdk");
  assert.equal(found?.nodeId, "node-1");
  assert.equal(reg.size, 1);
});

test("lookup of an unknown session is undefined", async () => {
  const reg = new InMemorySessionLocationRegistry();
  assert.equal(await reg.lookup("nope"), undefined);
});

test("record replaces an existing mapping (session relocated)", async () => {
  const reg = new InMemorySessionLocationRegistry();
  await reg.record(loc({ agentServiceAddress: "unix:/tmp/a.sock" }));
  await reg.record(loc({ agentServiceAddress: "unix:/tmp/b.sock" }));
  assert.equal((await reg.lookup("s1"))?.agentServiceAddress, "unix:/tmp/b.sock");
  assert.equal(reg.size, 1);
});

test("forget drops the mapping", async () => {
  const reg = new InMemorySessionLocationRegistry();
  await reg.record(loc());
  await reg.forget("s1");
  assert.equal(await reg.lookup("s1"), undefined);
  assert.equal(reg.size, 0);
});

test("record requires a sessionId", async () => {
  const reg = new InMemorySessionLocationRegistry();
  await assert.rejects(reg.record(loc({ sessionId: "" })), /sessionId is required/);
});

test("stored entries are copies (no aliasing with caller mutations)", async () => {
  const reg = new InMemorySessionLocationRegistry();
  const original = loc({ nodeId: "node-1" });
  await reg.record(original);
  original.nodeId = "mutated";
  assert.equal((await reg.lookup("s1"))?.nodeId, "node-1");
  const read = await reg.lookup("s1");
  read!.nodeId = "also-mutated";
  assert.equal((await reg.lookup("s1"))?.nodeId, "node-1", "mutating a lookup result doesn't affect the registry");
});
