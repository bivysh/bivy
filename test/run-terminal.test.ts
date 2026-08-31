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
  const broadcasts: any[] = [];
  const metadata: any[] = [];
  const runLogs = new Map<string, any>();
  let listChanged = 0;
  const deps: RunTerminalDeps = {
    terminals,
    broadcast: (p) => { broadcasts.push(p); },
    sendRelayEvent: () => {},
    sendNotificationHint: () => {},
    createSession: over.createSession ?? (async (_ws, sf) => { created.push(sf ?? "<fresh>"); return { id: "new-session" }; }),
    resolveSession: over.resolveSession ?? (() => undefined),
    sessionBusy: () => false,
    sessionTerminalsRecord: async () => {},
    sessionTerminalsForget: async () => {},
    upsertSessionMetadata: (patch) => { metadata.push(patch); },
    sessionListChanged: () => { listChanged += 1; },
    saveRunLog: (termId, log) => { runLogs.set(termId, log); return `/logs/${termId}.json`; },
    loadRunLog: (termId) => runLogs.get(termId),
    listAllSessions: async () => [],
    listProvidersUnified: async () => [],
    pushModelAuthToControlPlane: async () => {},
    listPiSessions: over.listPiSessions ?? (async () => []),
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
  return { deps, terminals, emitted, created, broadcasts, metadata, runLogs, listChanged: () => listChanged, emit, rt: createRunTerminals(deps) };
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
    assert.deepEqual(terminals.calls.close, ["t1"], "the PTY closes only after governed resume succeeds");
  }
});

test("a failed governed resume leaves the native terminal running", async () => {
  const terminals = fakeTerminals({
    list: () => [{ id: "t1", meta: { kind: "run", agent: "claude", sessionId: "sess-abc" }, workspace: "/w", createdAt: 0 }],
  });
  const { rt, emit } = harness({ terminals, createSession: async () => { throw new Error("resume failed"); } });
  await rt.openRunTerminal({ command: "claude", args: [], agent: "claude", sessionId: "sess-abc" }, emit);
  await assert.rejects(() => rt.takeoverRunTerminal({ termId: "t1" }), /resume failed/);
  assert.deepEqual(terminals.calls.close, [], "a failed preparation must not kill the user's working TUI");
  assert.equal(rt.hasRunTerminal("t1"), true);
});

test("takeover retries a lazily persisted Pi session", async () => {
  const createdAt = Date.now();
  const terminals = fakeTerminals({
    list: () => [{ id: "t1", meta: { kind: "run", agent: "pi" }, workspace: "/w", createdAt }],
  });
  let lists = 0;
  const { rt, emit, created } = harness({
    terminals,
    listPiSessions: async () => ++lists < 3 ? [] : [{ id: "pi-id", path: "/sessions/pi.jsonl", cwd: "/w", created: new Date(createdAt) }],
  });
  await rt.openRunTerminal({ command: "pi", args: [], agent: "pi", workspace: "/w" }, emit);
  const result = await rt.takeoverRunTerminal({ termId: "t1" });
  assert.equal(result.ok, true);
  assert.equal(lists, 3);
  assert.deepEqual(created, ["/sessions/pi.jsonl"]);
});

// --- `bivy run` sessions in the sidebar ---------------------------------------
// A run pinned to a session id (claude/grok) is a durable session from the moment
// it starts: the node records it (status "working"), pushes the session list and
// re-advertises so every client — including ones on other nodes, which never see
// this node's terminal.created — gets the row. When the PTY exits, the session
// flips to "saved" and the list is pushed again, so the saved row takes the
// Running row's place instead of vanishing until the next poll.
test("a pinned run records a working session and pushes the session list on open", async () => {
  const terminals = fakeTerminals({ meta: () => ({ kind: "run", agent: "claude", sessionId: "sess-1" }) });
  const { rt, emit, metadata, listChanged } = harness({ terminals });
  await rt.openRunTerminal({ command: "claude", args: ["--session-id", "sess-1"], agent: "claude", sessionId: "sess-1", workspace: "/w/repo" }, emit);
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].id, "sess-1");
  assert.equal(metadata[0].status, "working");
  assert.equal(metadata[0].source, "cli");
  assert.equal(metadata[0].runtimeId, "claude-code-sdk");
  assert.equal(metadata[0].name, "claude · repo", "a default name so the row is never an untitled empty shell");
  assert.equal(listChanged(), 1, "clients + control plane learn about the row immediately");
  assert.equal(rt.hasLiveRunForSession("sess-1"), true, "list surfaces report this session as working while the PTY lives");
  assert.equal(rt.hasLiveRunForSession("other"), false);
});

test("when a pinned run exits, its session is saved and the list is pushed again", async () => {
  const terminals = fakeTerminals({ meta: () => ({ kind: "run", agent: "claude", sessionId: "sess-2" }) });
  const { rt, emit, metadata, listChanged, broadcasts } = harness({ terminals });
  await rt.openRunTerminal({ command: "claude", args: [], agent: "claude", sessionId: "sess-2", workspace: "/w/repo" }, emit);
  const opened = terminals.calls.open[0];
  opened.onExit(0);
  // The exit path resolves the session ref asynchronously (discovery for
  // lazily-assigned ids); let it settle.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rt.hasLiveRunForSession("sess-2"), false, "no longer a live run");
  assert.equal(metadata.at(-1).status, "saved");
  assert.equal(metadata.at(-1).id, "sess-2");
  assert.equal(listChanged(), 2, "open + exit each push the list");
  assert.ok(broadcasts.some((b) => b.type === "terminal.closed"), "the Running row is retired; the pushed list puts the saved session in its place");
});

test("a run with no session id and no discoverable session keeps its scrollback as a run log", async () => {
  // Any agent Bivy has no session reader for — and the raw `bivy run -- <cmd>`
  // form — still leaves a durable row: the terminal output, keyed by the run's
  // own terminal id, opened read-only (source "cli:log"), never as a chat.
  const terminals = fakeTerminals({ meta: () => ({ kind: "run", agent: "aider" }) });
  const { rt, emit, metadata, listChanged, runLogs } = harness({ terminals });
  await rt.openRunTerminal({ command: "aider", args: [], agent: "aider", workspace: "/w/repo" }, emit);
  assert.equal(metadata.length, 0, "nothing durable to record while it runs without a session id");
  assert.equal(listChanged(), 0);
  terminals.calls.open[0].onExit(0, undefined, "aider v0.80\r\n> hello\r\n");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].id, "t1", "keyed by the run's terminal id");
  assert.equal(metadata[0].source, "cli:log");
  assert.equal(metadata[0].status, "saved");
  assert.equal(metadata[0].runLog, "/logs/t1.json");
  assert.equal(metadata[0].agentName, "aider");
  assert.equal(metadata[0].name, "aider · repo");
  assert.deepEqual(runLogs.get("t1")?.data, "aider v0.80\r\n> hello\r\n");
  assert.equal(listChanged(), 1, "the saved row is pushed to every client");
  // Attaching to the ended run replays the stored log and its exit, read-only.
  const out: any[] = [];
  rt.handleTerminalMessage({ kind: "terminal.attach", termId: "t1" } as any, (e) => out.push(e), new Set(), "c1");
  assert.deepEqual(out.map((e) => e.type), ["terminal.attached", "terminal.exit"]);
  assert.equal(out[0].data, "aider v0.80\r\n> hello\r\n");
  assert.equal(out[0].replay, true);
});

test("a raw `bivy run -- <command>` with no agent is kept as a run log too", async () => {
  const terminals = fakeTerminals({ meta: () => ({ kind: "run" }) });
  const { rt, emit, metadata } = harness({ terminals });
  await rt.openRunTerminal({ command: "bash", args: ["-c", "make test"], workspace: "/w/repo" }, emit);
  terminals.calls.open[0].onExit(2, undefined, "make: *** [test] Error 2\r\n");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].source, "cli:log");
  assert.equal(metadata[0].agentName, "bash");
  assert.equal(metadata[0].name, "bash · repo");
});

test("a run that produced no output leaves no row at all", async () => {
  const terminals = fakeTerminals({ meta: () => ({ kind: "run", agent: "aider" }) });
  const { rt, emit, metadata, listChanged } = harness({ terminals });
  await rt.openRunTerminal({ command: "aider", args: [], agent: "aider", workspace: "/w/repo" }, emit);
  terminals.calls.open[0].onExit(0, undefined, "   ");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(metadata.length, 0);
  assert.equal(listChanged(), 1, "the list is still pushed (harmless) so clients reconcile the Running row");
});

test("a mux attach (tmux/zellij) is not a session and never touches the list", async () => {
  const terminals = fakeTerminals({ meta: () => ({ kind: "run", agent: "tmux", mux: "tmux:main" }) });
  const { rt, emit, metadata, listChanged } = harness({ terminals });
  await rt.openRunTerminal({ command: "tmux", args: ["attach"], agent: "tmux", mux: "tmux:main" }, emit);
  terminals.calls.open[0].onExit(0);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(metadata.length, 0);
  assert.equal(listChanged(), 0);
});
