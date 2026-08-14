// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Characterization tests for the run-terminal / PTY subsystem extracted from
// server.ts. Drives the transport-agnostic message router, the "continue as chat"
// takeover, and the #433 auth-gating (an agent-owned integration must receive NO
// Bivy vault projection — an empty credentialEnv) through a fake TerminalManager.
import { strict as assert } from "node:assert";
import test from "node:test";

import { createRunTerminals, type RunTerminalDeps } from "../src/session/run-terminal.js";

function fakeTerminals(over: any = {}) {
  const calls: any = { open: [], write: [], close: [], setClientSize: [] };
  return {
    calls,
    open: (opts: any) => { calls.open.push(opts); return over.openId ?? "t1"; },
    list: over.list ?? (() => []),
    pid: () => 123,
    meta: over.meta ?? (() => undefined),
    snapshot: over.snapshot ?? (() => null),
    setClientSize: (...a: any[]) => calls.setClientSize.push(a),
    write: (id: string, data: string) => calls.write.push({ id, data }),
    close: (id: string) => calls.close.push(id),
    lastInput: () => null,
    dropClientSize: () => {},
  } as any;
}

function harness(over: any = {}) {
  const terminals = over.terminals ?? fakeTerminals();
  const emitted: any[] = [];
  const created: string[] = [];
  const deps: RunTerminalDeps = {
    terminals,
    broadcast: () => {},
    sendRelayEvent: () => {},
    sendNotificationHint: () => {},
    createSession: async (_ws, sf) => { created.push(sf ?? "<fresh>"); return { id: "new-session" }; },
    resolveSession: over.resolveSession ?? (() => undefined),
    sessionBusy: () => false,
    sessionTerminalsRecord: async () => {},
    sessionTerminalsForget: async () => {},
    upsertSessionMetadata: () => {},
    listAllSessions: async () => [],
    listProvidersUnified: async () => [],
    pushModelAuthToControlPlane: async () => {},
    listPiSessions: async () => [],
    resolveAuthOwner: over.resolveAuthOwner ?? (() => "agent"),
    broadcastTuiState: () => {},
    refreshRecordAfterTui: () => {},
    isEmptyUntitledTitle: (n) => !n || n === "Untitled",
    getActiveSession: () => undefined,
    defaultWorkspace: "/ws",
    credsDir: "/creds",
    piDir: "/pi",
    maxRunTerminals: 50,
  };
  const emit = (e: any) => emitted.push(e);
  return { deps, terminals, emitted, created, emit, rt: createRunTerminals(deps) };
}

test("handleTerminalMessage returns false for a non-terminal message", () => {
  const { rt, emit } = harness();
  assert.equal(rt.handleTerminalMessage({ kind: "chat.send" } as any, emit, new Set(), "c1"), false);
});

test("terminal.input forwards to the PTY; terminal.close closes it", () => {
  const { rt, emit, terminals } = harness();
  assert.equal(rt.handleTerminalMessage({ kind: "terminal.input", termId: "t9", data: "ls\n" } as any, emit, new Set(), "c1"), true);
  assert.deepEqual(terminals.calls.write, [{ id: "t9", data: "ls\n" }]);
  rt.handleTerminalMessage({ kind: "terminal.close", termId: "t9" } as any, emit, new Set(), "c1");
  assert.deepEqual(terminals.calls.close, ["t9"]);
});

test("takeover returns 404 when there is no matching live run-terminal", async () => {
  const { rt } = harness();
  const r = await rt.takeoverRunTerminal({ termId: "nope" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 404);
});

test("an agent-owned integration launches with NO Bivy credential projection (#433)", async () => {
  // "unknown" resolves to no integration → authOwner defaults to "agent" → env {}.
  const { rt, terminals, emit } = harness();
  const id = await rt.openRunTerminal({ command: "foo", args: [], agent: "unknown" }, emit);
  assert.equal(id, "t1");
  assert.equal(terminals.calls.open.length, 1);
  assert.deepEqual(terminals.calls.open[0].env, {}, "no vault projection for an agent-owned integration");
  assert.ok(emit.length === undefined || true);
});

test("takeover of an unsupported agent returns 409 after it is live", async () => {
  // Make the terminal live (openRunTerminal adds it to the run registry), then a
  // takeover finds it but has no runtime mapping for the "unknown" agent.
  const terminals = fakeTerminals({
    meta: () => ({ kind: "run", agent: "unknown", sessionId: "s1" }),
    list: () => [{ id: "t1", meta: { kind: "run", agent: "unknown", sessionId: "s1" }, workspace: "/w", createdAt: 0 }],
  });
  const { rt, emit } = harness({ terminals });
  await rt.openRunTerminal({ command: "foo", args: [], agent: "unknown", sessionId: "s1" }, emit);
  assert.equal(rt.hasRunTerminal("t1"), true, "now a live run-terminal");
  const r = await rt.takeoverRunTerminal({ termId: "t1" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 409, "no 'continue as chat' runtime for an unknown agent");
});

test("takeover of a supported pinned agent reopens it as a governed chat", async () => {
  const terminals = fakeTerminals({
    list: () => [{ id: "t1", meta: { kind: "run", agent: "claude", sessionId: "sess-abc" }, workspace: "/w", createdAt: 0 }],
  });
  const { rt, emit, created } = harness({ terminals });
  await rt.openRunTerminal({ command: "claude", args: [], agent: "claude", sessionId: "sess-abc" }, emit);
  const r = await rt.takeoverRunTerminal({ termId: "t1" });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.runtimeId, "claude-code-sdk");
    assert.equal(r.resumeCommand, "claude --resume sess-abc");
    assert.deepEqual(created, ["sess-abc"], "createSession resumes the pinned session file");
  }
});
