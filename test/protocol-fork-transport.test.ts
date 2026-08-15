// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";

import { ProtocolRuntime } from "../src/runtime/protocol.js";
import type { ForkNativePayload } from "../src/runtime/types.js";

// The constructor sets capabilities + wires the delegating methods without ever
// spawning the child, so these assert the native-transport plumbing in isolation.

test("forkTransport is advertised only when BOTH hooks are present", () => {
  const neither = new ProtocolRuntime({ command: "node", id: "x" });
  assert.equal(neither.capabilities.forkTransport, undefined);

  const exportOnly = new ProtocolRuntime({ command: "node", id: "x", exportForFork: () => undefined });
  assert.notEqual(exportOnly.capabilities.forkTransport, true, "export alone is inert");

  const both = new ProtocolRuntime({
    command: "node",
    id: "codex",
    exportForFork: () => ({ runtimeId: "ignored", kind: "k", data: {} }),
    importForFork: async () => ({ sessionFile: "s", id: "s" }),
  });
  assert.equal(both.capabilities.forkTransport, true, "both hooks → forkTransport");
});

test("exportForFork stamps this runtime's id (so the engine imports into a match)", () => {
  const rt = new ProtocolRuntime({
    command: "node",
    id: "codex",
    exportForFork: () => ({ runtimeId: "whatever", kind: "codex-rollout", data: { jsonl: "x" } }),
    importForFork: async () => ({ sessionFile: "s", id: "s" }),
  });
  const payload = rt.exportForFork("ref");
  assert.equal(payload?.runtimeId, "codex", "runtimeId overwritten to the runtime's own id");
  assert.equal(payload?.kind, "codex-rollout");
});

test("exportForFork returns undefined when the hook has nothing to export", () => {
  const rt = new ProtocolRuntime({ command: "node", id: "codex", exportForFork: () => undefined, importForFork: async () => ({ sessionFile: "s", id: "s" }) });
  assert.equal(rt.exportForFork("ref"), undefined);
});

test("importForFork delegates to the hook", async () => {
  let received: ForkNativePayload | undefined;
  const rt = new ProtocolRuntime({
    command: "node",
    id: "codex",
    exportForFork: () => undefined,
    importForFork: async (payload, ctx) => { received = payload; return { sessionFile: ctx.cwd, id: "new" }; },
  });
  const out = await rt.importForFork({ runtimeId: "codex", kind: "codex-rollout", data: { jsonl: "x" } }, { workspace: "/w", cwd: "/w/cwd" });
  assert.equal(out.id, "new");
  assert.equal(out.sessionFile, "/w/cwd");
  assert.equal(received?.kind, "codex-rollout");
});

test("importForFork throws when no hook is configured", async () => {
  const rt = new ProtocolRuntime({ command: "node", id: "x" });
  await assert.rejects(() => rt.importForFork({ runtimeId: "x", kind: "k", data: {} }, { workspace: "/w", cwd: "/w" }), /does not support native fork transport/);
});
