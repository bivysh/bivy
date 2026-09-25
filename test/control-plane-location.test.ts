// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import { ControlPlaneSessionLocationRegistry, LayeredSessionLocationRegistry, type NodeSessionRow } from "../src/runtime/control-plane-location.js";
import { InMemorySessionLocationRegistry, type SessionLocation } from "../src/runtime/session-location.js";

function cpRegistry(rows: NodeSessionRow[], runtimeIds: Record<string, string | undefined> = {}, nodeId = "node-1") {
  return new ControlPlaneSessionLocationRegistry({
    fetchNodeSessions: async () => rows,
    resolveRuntimeId: (id) => runtimeIds[id] ?? "claude-code-sdk",
    nodeId,
  });
}

test("lookup returns a routable location from a durable row", async () => {
  const reg = cpRegistry([{ sessionId: "s1", agentServiceAddress: "unix:/run/a.sock" }]);
  const loc = await reg.lookup("s1");
  assert.deepEqual(loc, { sessionId: "s1", agentServiceAddress: "unix:/run/a.sock", runtimeId: "claude-code-sdk", nodeId: "node-1" });
});

test("a row without an address is not adoptable", async () => {
  const reg = cpRegistry([{ sessionId: "s1" }]);
  assert.equal(await reg.lookup("s1"), undefined);
  assert.deepEqual(await reg.listNode(), []);
});

test("a row whose runtime id can't be resolved is not adoptable", async () => {
  const reg = new ControlPlaneSessionLocationRegistry({
    fetchNodeSessions: async () => [{ sessionId: "s1", agentServiceAddress: "unix:/a.sock" }],
    resolveRuntimeId: () => undefined,
  });
  assert.equal(await reg.lookup("s1"), undefined);
  assert.deepEqual(await reg.listNode(), []);
});

test("listNode returns only adoptable rows (address + resolvable runtime)", async () => {
  const reg = new ControlPlaneSessionLocationRegistry({
    fetchNodeSessions: async () => [
      { sessionId: "live", agentServiceAddress: "unix:/a.sock" },
      { sessionId: "saved" }, // no address → not adoptable
      { sessionId: "unknown-rt", agentServiceAddress: "unix:/b.sock" }, // no runtime id → not adoptable
    ],
    resolveRuntimeId: (id) => (id === "live" ? "claude-code-sdk" : undefined),
    nodeId: "node-1",
  });
  const adoptable = await reg.listNode();
  assert.deepEqual(adoptable.map((l) => l.sessionId), ["live"]);
});

test("a fetch failure degrades to unknown, never throws", async () => {
  const reg = new ControlPlaneSessionLocationRegistry({
    fetchNodeSessions: async () => {
      throw new Error("control plane unreachable");
    },
    resolveRuntimeId: () => "claude-code-sdk",
  });
  assert.equal(await reg.lookup("s1"), undefined);
  assert.deepEqual(await reg.listNode(), []);
});

test("record/forget are no-ops (advertise owns control-plane writes)", async () => {
  let fetched = 0;
  const reg = new ControlPlaneSessionLocationRegistry({
    fetchNodeSessions: async () => {
      fetched++;
      return [];
    },
    resolveRuntimeId: () => "claude-code-sdk",
  });
  await reg.record({ sessionId: "s1", agentServiceAddress: "unix:/a.sock", runtimeId: "claude-code-sdk" });
  await reg.forget("s1");
  assert.equal(fetched, 0, "no writes hit the control plane");
});

test("layered registry prefers in-memory, falls through to control plane on a miss", async () => {
  const memory = new InMemorySessionLocationRegistry();
  const cp = cpRegistry([{ sessionId: "cp-only", agentServiceAddress: "unix:/cp.sock" }]);
  const layered = new LayeredSessionLocationRegistry(memory, cp);

  // In-memory hit wins even when the control plane also has a (different) row.
  await layered.record({ sessionId: "local", agentServiceAddress: "unix:/local.sock", runtimeId: "claude-code-sdk" });
  assert.equal((await layered.lookup("local"))?.agentServiceAddress, "unix:/local.sock");

  // Miss in memory → resolved from the control plane.
  const fromCp = await layered.lookup("cp-only");
  assert.equal(fromCp?.agentServiceAddress, "unix:/cp.sock");

  // forget clears the in-memory (writable) layer.
  await layered.forget("local");
  assert.equal(await memory.lookup("local"), undefined);
});

// --- merged from session-location.test.ts ---
{
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
}
