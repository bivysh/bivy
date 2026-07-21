// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { RemoteRuntime, startRemoteSession, type RpcTransport } from "../src/runtime/remote.js";
import type { ClientMessage, InitialSnapshot, ServerMessage } from "../src/runtime/rpc-protocol.js";
import type { RuntimeCapabilities, RuntimeEvent } from "../src/runtime/types.js";

// A fake transport that captures outbound client messages and lets the test
// drive inbound server messages — the injectable pattern from backpressure.ts.
function fakeTransport() {
  let messageHandler: ((m: ServerMessage) => void) | undefined;
  let closeHandler: ((err?: Error) => void) | undefined;
  const sent: ClientMessage[] = [];
  let closed = false;
  const transport: RpcTransport = {
    send: (m) => sent.push(m),
    onMessage: (h) => (messageHandler = h),
    onClose: (h) => (closeHandler = h),
    close: () => (closed = true),
  };
  return {
    transport,
    sent,
    isClosed: () => closed,
    deliver: (m: ServerMessage) => messageHandler?.(m),
    drop: (err?: Error) => closeHandler?.(err),
    /** Reply "started" to a captured `start`/`rt` frame. */
    respondStarted: (snapshot: InitialSnapshot) => messageHandler?.({ t: "started", id: 1, snapshot }),
  };
}

const CAPS: RuntimeCapabilities = { toolInterception: true, modelSelection: true, packages: false, resume: true, fork: true };

function baseSnapshot(over: Partial<InitialSnapshot> = {}): InitialSnapshot {
  return {
    sessionId: "sess-1",
    cwd: "/tmp/ws",
    isStreaming: false,
    messages: [],
    capabilities: CAPS,
    supportsThinking: false,
    availableThinkingLevels: [],
    commands: [],
    ...over,
  };
}

async function startSession(ft: ReturnType<typeof fakeTransport>, snapshot: InitialSnapshot, toolInterceptor?: Parameters<typeof startRemoteSession>[2]) {
  const promise = startRemoteSession(ft.transport, { runtime: "claude-code-sdk", op: "create", options: { workspace: "/tmp/ws" } }, toolInterceptor);
  ft.respondStarted(snapshot);
  return (await promise).session;
}

test("handshake populates the mirror and sends a start frame", async () => {
  const ft = fakeTransport();
  const session = await startSession(ft, baseSnapshot({ name: "Alpha", sessionFile: "/s/1.json", currentModel: { provider: "anthropic", id: "opus", name: "Opus" } }));
  assert.equal(ft.sent[0]?.t, "start");
  assert.equal(session.id, "sess-1");
  assert.equal(session.cwd, "/tmp/ws");
  assert.equal(session.getName(), "Alpha");
  assert.equal(session.sessionFile, "/s/1.json");
  assert.equal(session.getCurrentModel()?.id, "opus");
  assert.equal(session.isStreaming, false);
});

test("replays events buffered between started and wiring", async () => {
  const ft = fakeTransport();
  const promise = startRemoteSession(ft.transport, { runtime: "r", op: "create", options: {} }, {});
  // Deliver started AND a follow-on event before the session object exists.
  ft.respondStarted(baseSnapshot());
  ft.deliver({ t: "event", event: { type: "agent_start" } });
  ft.deliver({ t: "event", event: { type: "turn_start" } });
  const session = (await promise).session;
  const seen: RuntimeEvent[] = [];
  session.subscribe((e) => seen.push(e));
  // The two buffered events were replayed into the emitter before subscribe,
  // so they are NOT re-seen; but a new event is.
  ft.deliver({ t: "event", event: { type: "message_start" } });
  assert.deepEqual(seen.map((e) => e.type), ["message_start"]);
});

test("prompt round-trips a req/res", async () => {
  const ft = fakeTransport();
  const session = await startSession(ft, baseSnapshot());
  const p = session.prompt("hello", { streamingBehavior: "steer" });
  const req = ft.sent.find((m) => m.t === "req");
  assert.ok(req && req.t === "req" && req.method === "prompt");
  assert.deepEqual(req.args, ["hello", { streamingBehavior: "steer" }]);
  ft.deliver({ t: "res", id: req.id, ok: true, value: undefined });
  await p; // resolves
});

test("snapshot on the agent_end frame is applied BEFORE the event is emitted", async () => {
  const ft = fakeTransport();
  const session = await startSession(ft, baseSnapshot({ isStreaming: true }));
  let atEnd: { file?: string; count?: number } = {};
  session.subscribe((e) => {
    if (e.type === "agent_end") atEnd = { file: session.sessionFile, count: session.getMessages().length };
  });
  ft.deliver({
    t: "event",
    event: { type: "agent_end", code: 0, signal: null },
    snapshot: { isStreaming: false, sessionFile: "/s/after.json", messages: [{ role: "user" }, { role: "assistant" }] },
  });
  // The daemon's agent_end handler must observe the post-turn state.
  assert.equal(atEnd.file, "/s/after.json");
  assert.equal(atEnd.count, 2);
  assert.equal(session.isStreaming, false);
});

test("intercept invokes the daemon interceptor and replies with the decision", async () => {
  const ft = fakeTransport();
  const calls: string[] = [];
  await startSession(ft, baseSnapshot(), {
    toolInterceptor: (ctx) => {
      calls.push(ctx.toolName);
      return { block: true, reason: "nope" };
    },
  });
  ft.deliver({ t: "intercept", id: 7, ctx: { sessionId: "sess-1", toolName: "Bash", input: { cmd: "rm" } } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ["Bash"]);
  const reply = ft.sent.find((m) => m.t === "intercept-res");
  assert.ok(reply && reply.t === "intercept-res" && reply.id === 7);
  assert.deepEqual(reply.decision, { block: true, reason: "nope" });
});

test("abort settles a blocked interceptor via its signal", async () => {
  const ft = fakeTransport();
  let aborted = false;
  const session = await startSession(ft, baseSnapshot({ isStreaming: true }), {
    toolInterceptor: (ctx) =>
      new Promise((resolve) => {
        ctx.signal?.addEventListener("abort", () => {
          aborted = true;
          resolve({ handled: true, result: "cancelled" });
        });
      }),
  });
  ft.deliver({ t: "intercept", id: 9, ctx: { sessionId: "sess-1", toolName: "AskUserQuestion", input: {} } });
  await new Promise((r) => setImmediate(r));
  void session.abort();
  await new Promise((r) => setImmediate(r));
  assert.equal(aborted, true, "abort() fired the interceptor's abort signal");
});

test("a dropped link fails a live turn with session.error + agent_end", async () => {
  const ft = fakeTransport();
  const session = await startSession(ft, baseSnapshot({ isStreaming: true }));
  const seen: RuntimeEvent[] = [];
  session.subscribe((e) => seen.push(e));
  ft.drop(new Error("boom"));
  assert.deepEqual(seen.map((e) => e.type), ["session.error", "agent_end"]);
  assert.equal(session.isStreaming, false);
});

test("setName mirrors optimistically and notifies the service", async () => {
  const ft = fakeTransport();
  const session = await startSession(ft, baseSnapshot());
  session.setName("Renamed");
  assert.equal(session.getName(), "Renamed");
  const notify = ft.sent.find((m) => m.t === "notify" && m.method === "setName");
  assert.ok(notify && notify.t === "notify");
  assert.deepEqual(notify.args, ["Renamed"]);
});

test("dispose notifies, closes the transport, and rejects pending calls", async () => {
  const ft = fakeTransport();
  const session = await startSession(ft, baseSnapshot());
  const pending = session.getUsage();
  session.dispose();
  assert.ok(ft.sent.some((m) => m.t === "notify" && m.method === "dispose"));
  assert.equal(ft.isClosed(), true);
  await assert.rejects(pending, /disposed/);
});

test("setModel applies the currentModel from the response snapshot", async () => {
  const ft = fakeTransport();
  const session = await startSession(ft, baseSnapshot());
  const p = session.setModel("anthropic", "sonnet");
  const req = ft.sent.find((m) => m.t === "req" && m.method === "setModel");
  assert.ok(req && req.t === "req");
  ft.deliver({ t: "res", id: req.id, ok: true, value: undefined, snapshot: { currentModel: { provider: "anthropic", id: "sonnet", name: "Sonnet" } } });
  await p;
  assert.equal(session.getCurrentModel()?.id, "sonnet");
});

test("RemoteRuntime.createSession opens a transport and starts a session", async () => {
  const ft = fakeTransport();
  const runtime = new RemoteRuntime({ targetRuntime: "claude-code-sdk", displayName: "Claude", capabilities: CAPS, connect: async () => ft.transport });
  const resultPromise = runtime.createSession({ workspace: "/tmp/ws" });
  await new Promise((r) => setImmediate(r)); // let the async connect() resolve
  ft.respondStarted(baseSnapshot({ cwd: "/tmp/ws" }));
  const { session } = await resultPromise;
  assert.equal(session.cwd, "/tmp/ws");
  const start = ft.sent.find((m) => m.t === "start");
  assert.ok(start && start.t === "start" && start.op === "create");
});

test("RemoteRuntime.listSessions issues a runtime-level rt call", async () => {
  const ft = fakeTransport();
  const runtime = new RemoteRuntime({ targetRuntime: "claude-code-sdk", displayName: "Claude", capabilities: CAPS, connect: async () => ft.transport });
  const p = runtime.listSessions();
  await new Promise((r) => setImmediate(r)); // let the async connect() resolve
  const rt = ft.sent.find((m) => m.t === "rt");
  assert.ok(rt && rt.t === "rt" && rt.method === "listSessions");
  ft.deliver({ t: "res", id: rt.id, ok: true, value: [{ id: "s1" }] });
  assert.deepEqual(await p, [{ id: "s1" }]);
  assert.equal(ft.isClosed(), true, "the short-lived rt connection is closed after the reply");
});
