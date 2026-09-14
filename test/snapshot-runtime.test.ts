// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { rebuildSnapshotRuntime } from "../src/session/snapshot-runtime.js";
import { canonicalSession } from "../src/runtime/canonical-session.js";
import type { AgentRuntime, RuntimeSession } from "../src/runtime/types.js";

test("snapshot rebuild imports prior turns into the agent, preserving model and destination workspace", async () => {
  let calls = 0;
  const model = { provider: "provider", id: "selected-model" };
  const runtime = {
    id: "any-agent", capabilities: { forkHistoryImport: true },
    async importHistoryForFork(history: unknown, ctx: unknown) {
      calls++;
      assert.deepEqual(history, [{ role: "user", text: "Remember marker" }, { role: "assistant", text: "marker" }]);
      assert.deepEqual(ctx, { workspace: "/replacement", cwd: "/replacement", model });
      return { id: "new-native-id", sessionFile: "new-native-reference" };
    },
  } as AgentRuntime;
  const ref = await rebuildSnapshotRuntime({ runtimeId: runtime.id, model }, runtime, [
    { role: "user", content: "Remember marker" },
    { role: "assistant", content: [{ type: "text", text: "marker" }] },
  ], "/replacement");
  assert.equal(ref, "new-native-reference");
  assert.equal(calls, 1);
});

test("unsupported, empty and failed replay never masquerade as restored native state", async () => {
  const rt = { id: "agent", capabilities: { forkHistoryImport: false } } as AgentRuntime;
  const info = { runtimeId: rt.id };
  await assert.rejects(() => rebuildSnapshotRuntime(info, rt, [], "/new"), /cannot replay/);
  await assert.rejects(() => rebuildSnapshotRuntime({ runtimeId: "other" }, rt, [], "/new"), /identity mismatch/);
  rt.capabilities.forkHistoryImport = true;
  rt.importHistoryForFork = async () => { throw new Error("native import failed"); };
  await assert.rejects(() => rebuildSnapshotRuntime(info, rt, [], "/new"), /no replayable conversation/);
  await assert.rejects(() => rebuildSnapshotRuntime(info, rt, [{ role: "user", content: "prior turn" }], "/new"), /native import failed/);
});

test("canonical facade keeps Bivy identity without changing native ids or private-field receivers", () => {
  class Native {
    readonly id = "native-id";
    #name = "native";
    get name() { return this.#name; }
    setName(name: string) { this.#name = name; }
    nativeIdentity() { return this.id; }
  }
  const native = Object.freeze(new Native());
  const session = native as unknown as RuntimeSession;
  assert.equal(canonicalSession(session), session);
  assert.equal(canonicalSession(session, native.id), session);
  const facade = canonicalSession(session, "durable-bivy-id") as unknown as Native;
  assert.equal(facade.id, "durable-bivy-id");
  assert.equal(facade.nativeIdentity(), "native-id");
  assert.equal(facade.name, "native");
  facade.setName("updated");
  assert.equal(facade.name, "updated");
  assert.equal(facade.setName, facade.setName);
  assert.equal(native.id, "native-id");
  assert.ok(Object.keys(facade).includes("id"));
  assert.ok(facade instanceof Native);
});
