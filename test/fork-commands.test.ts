// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";

import { createForkCommands, type ForkCommandDeps } from "../src/controllers/fork-commands.js";

type Ctx = { reply: (e: unknown) => void };
const CTX: Ctx = { reply: () => {} };

function harness(over: Partial<ForkCommandDeps> = {}) {
  const events: any[] = [];
  const broadcasts: any[] = [];
  const rec: any = { id: "s1", runtimeId: "codex", workspace: "/tmp", sessionFile: "ref", worktree: undefined, session: { getMessages: () => [], cwd: "/tmp" } };
  const deps: ForkCommandDeps = {
    sendEvent: (e) => events.push(e),
    broadcast: (e) => broadcasts.push(e),
    resolveSession: () => rec,
    getRuntime: () => ({ id: "codex", capabilities: {} }) as any,
    forkRecordFor: () => ({ sourceSessionId: "s1", runtimeId: "codex", workspace: "/tmp", cwd: "/tmp", repoSlug: "octo/repo" }) as any,
    forkInFlightState: () => undefined,
    forkDoneEvent: (requestId, record) => ({ type: "session.fork.done", requestId, sessionId: (record as any).id }),
    agentFrom: () => undefined,
    modelFrom: () => undefined,
    pushModelAuthToControlPlane: async () => {},
    pushForkSourceBranch: async () => {},
    forkWorkspaceMaxBytes: () => 50 * 1024 * 1024,
    standUpFork: async () => ({ ok: true, record: rec, plan: { kind: "seed", fidelity: "seeded", seedPrompt: "hi" }, missing: [] }) as any,
    retireSource: async () => ({ ok: true, retired: true, alreadyGone: false }),
    ...over,
  };
  return { events, broadcasts, cmds: createForkCommands(deps) };
}

test("registers exactly the four fork command kinds", () => {
  const { cmds } = harness();
  assert.deepEqual(Object.keys(cmds).sort(), [
    "session.fork.export", "session.fork.import", "session.fork.local", "session.fork.retire-source",
  ]);
});

test("export emits a bundle for a known session", async () => {
  const { events, cmds } = harness();
  await (cmds["session.fork.export"] as any)({ kind: "session.fork.export", sessionId: "s1", requestId: "r1" }, CTX);
  const bundle = events.find((e) => e.type === "session.fork.bundle");
  assert.ok(bundle, "emits session.fork.bundle");
  assert.equal(bundle.requestId, "r1");
});

test("export emits an error when the session is unknown", async () => {
  const { events, cmds } = harness({ resolveSession: () => undefined });
  await (cmds["session.fork.export"] as any)({ kind: "session.fork.export", sessionId: "nope" }, CTX);
  assert.match(events.find((e) => e.type === "session.fork.error")?.error ?? "", /not found/);
});

test("export pushes the source branch only for a cross-node fork", async () => {
  let pushed = 0;
  const { cmds } = harness({ pushForkSourceBranch: async () => { pushed++; } });
  await (cmds["session.fork.export"] as any)({ kind: "session.fork.export", sessionId: "s1" }, CTX);
  assert.equal(pushed, 0, "same-node export does not push");
  await (cmds["session.fork.export"] as any)({ kind: "session.fork.export", sessionId: "s1", crossNode: true }, CTX);
  assert.equal(pushed, 1, "cross-node export publishes the branch");
});

test("import rejects a malformed bundle", async () => {
  const { events, cmds } = harness();
  await (cmds["session.fork.import"] as any)({ kind: "session.fork.import", bundle: {} }, CTX);
  assert.match(events.find((e) => e.type === "session.fork.error")?.error ?? "", /Malformed/);
});

test("import stands up the session and emits fork.done", async () => {
  const { events, cmds } = harness();
  await (cmds["session.fork.import"] as any)({ kind: "session.fork.import", requestId: "r2", bundle: { record: { runtimeId: "codex" }, normalized: { turns: [] } } }, CTX);
  const done = events.find((e) => e.type === "session.fork.done");
  assert.ok(done, "emits session.fork.done on success");
  assert.equal(done.requestId, "r2");
});

test("import surfaces a blocking prereq without standing up", async () => {
  const { events, cmds } = harness({ standUpFork: async () => ({ ok: false, error: "Codex not installed", missing: [{ kind: "agent" }] }) as any });
  await (cmds["session.fork.import"] as any)({ kind: "session.fork.import", bundle: { record: {}, normalized: { turns: [] } } }, CTX);
  const err = events.find((e) => e.type === "session.fork.error");
  assert.match(err?.error ?? "", /not installed/);
  assert.ok(Array.isArray(err.missing));
});

test("retire-source gate + broadcast wiring", async () => {
  const { events, broadcasts, cmds } = harness();
  await (cmds["session.fork.retire-source"] as any)({ kind: "session.fork.retire-source", sourceSessionId: "s1", newSessionId: "d1" }, CTX);
  assert.ok(broadcasts.find((e) => e.type === "session.deleted" && e.sessionId === "s1"), "broadcasts session.deleted on retire");
  assert.ok(events.find((e) => e.type === "session.fork.retired"), "replies session.fork.retired");

  const gated = harness({ retireSource: async () => ({ ok: false, error: "refusing without a confirmed destination" }) });
  await (gated.cmds["session.fork.retire-source"] as any)({ kind: "session.fork.retire-source", sourceSessionId: "s1", newSessionId: "" }, CTX);
  assert.match(gated.events.find((e) => e.type === "session.fork.error")?.error ?? "", /confirmed destination/);
  assert.equal(gated.broadcasts.length, 0, "no broadcast when the gate refuses");
});
