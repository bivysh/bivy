// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";

import { createCustomModelCommands, type CustomModelCommandDeps } from "../src/controllers/custom-model-commands.js";

function harness(over: Partial<CustomModelCommandDeps> = {}) {
  const events: any[] = [];
  const replies: any[] = [];
  const removed: string[] = [];
  const deps: CustomModelCommandDeps = {
    sendEvent: (e) => events.push(e),
    localModelSummaries: async () => [{ id: "local/llama" }],
    localModelPresets: async () => [{ id: "ollama" }],
    discoverModelsOnMachine: async () => ({ endpoints: ["http://localhost:11434"] }),
    verifyModelEndpoint: async () => ({ ok: true }),
    persistLocalModelSave: async () => ({ id: "machine/local-llama" }),
    persistLocalModelRemove: async (id) => { removed.push(id); },
    ...over,
  };
  const ctx = { reply: (e: unknown) => replies.push(e) } as any;
  return { events, replies, removed, ctx, cmds: createCustomModelCommands(deps) };
}

test("registers the models.custom cluster", () => {
  assert.deepEqual(Object.keys(harness().cmds).sort(), [
    "models.custom.discover", "models.custom.list", "models.custom.presets",
    "models.custom.remove", "models.custom.save", "models.custom.verify",
  ]);
});

test("list + presets emit their payloads", async () => {
  const h = harness();
  await (h.cmds["models.custom.list"] as any)({ kind: "models.custom.list" }, h.ctx);
  await (h.cmds["models.custom.presets"] as any)({ kind: "models.custom.presets" }, h.ctx);
  assert.deepEqual(h.events.find((e) => e.type === "models.custom.list")?.providers, [{ id: "local/llama" }]);
  assert.deepEqual(h.events.find((e) => e.type === "models.custom.presets")?.presets, [{ id: "ollama" }]);
});

test("discover replies ok, or error on failure", async () => {
  const ok = harness();
  await (ok.cmds["models.custom.discover"] as any)({ kind: "models.custom.discover" }, ok.ctx);
  assert.ok(ok.replies.find((e) => e.type === "models.custom.discover.ok" && Array.isArray(e.endpoints)));

  const bad = harness({ discoverModelsOnMachine: async () => { throw new Error("no probe"); } });
  await (bad.cmds["models.custom.discover"] as any)({ kind: "models.custom.discover" }, bad.ctx);
  assert.match(bad.replies.find((e) => e.type === "models.custom.discover.error")?.error ?? "", /no probe/);
});

test("save replies with the normalized provider id and errors cleanly", async () => {
  const ok = harness();
  await (ok.cmds["models.custom.save"] as any)({ kind: "models.custom.save", spec: { name: "x" }, requestId: "r1" }, ok.ctx);
  const reply = ok.replies.find((e) => e.type === "models.custom.save.ok");
  assert.equal(reply?.provider, "machine/local-llama");
  assert.equal(reply?.requestId, "r1");

  const bad = harness({ persistLocalModelSave: async () => { throw new Error("bad spec"); } });
  await (bad.cmds["models.custom.save"] as any)({ kind: "models.custom.save", requestId: "r2" }, bad.ctx);
  assert.match(bad.replies.find((e) => e.type === "models.custom.save.error")?.error ?? "", /bad spec/);
  assert.ok(bad.events.find((e) => e.type === "session.error"));
});

test("remove passes id (or falls back to provider)", async () => {
  const h = harness();
  await (h.cmds["models.custom.remove"] as any)({ kind: "models.custom.remove", id: "machine/x" }, h.ctx);
  await (h.cmds["models.custom.remove"] as any)({ kind: "models.custom.remove", provider: "machine/y" }, h.ctx);
  assert.deepEqual(h.removed, ["machine/x", "machine/y"]);
});
