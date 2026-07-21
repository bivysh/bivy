// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import test from "node:test";

import { AgentService, type ServiceConnection } from "../src/runtime/agent-service.js";
import type { ClientMessage, ServerMessage } from "../src/runtime/rpc-protocol.js";
import type {
  AgentRuntime,
  ModelInfo,
  OpenSessionOptions,
  OpenSessionResult,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeSession,
  SessionSummary,
  ToolInterceptor,
} from "../src/runtime/types.js";

// ---- A tiny echo runtime: one prompt → a full, deterministic turn ----------

let disposedSessions = 0;

class EchoSession implements RuntimeSession {
  readonly id = "echo-1";
  private readonly emitter = new EventEmitter();
  private streaming = false;
  private messages: RuntimeMessage[] = [];
  private _sessionFile?: string;
  private _name?: string;
  private _model?: ModelInfo;

  constructor(readonly cwd: string, private readonly interceptor?: ToolInterceptor) {}

  get sessionFile() {
    return this._sessionFile;
  }
  get isStreaming() {
    return this.streaming;
  }
  activePid() {
    return this.streaming ? 4242 : undefined;
  }
  getMessages() {
    return this.messages;
  }
  subscribe(listener: (event: RuntimeEvent) => void) {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
  private emit(event: RuntimeEvent) {
    this.emitter.emit("event", event);
  }

  async prompt(text: string): Promise<void> {
    this.streaming = true;
    this.messages.push({ role: "user", content: text });
    this.emit({ type: "agent_start" });
    this.emit({ type: "turn_start" });
    this.emit({ type: "message_start", message: { role: "assistant", content: "" } });
    let reply = text;
    if (this.interceptor) {
      const decision = (await this.interceptor({ sessionId: this.id, toolName: "Echo", input: { text } })) || {};
      if (decision.block) reply = `BLOCKED:${decision.reason ?? ""}`;
      else if (decision.handled) reply = String(decision.result ?? "");
      this.emit({ type: "tool_result", toolName: "Echo", blocked: Boolean(decision.block) });
    }
    this.emit({ type: "message_update", message: { role: "assistant", content: reply } });
    const message = { role: "assistant", content: reply };
    this.messages.push(message);
    // The resume ref materializes only after the first turn (like a real runtime).
    this._sessionFile = `/echo/${this.id}.json`;
    this.streaming = false;
    this.emit({ type: "message_end", message });
    this.emit({ type: "turn_end" });
    this.emit({ type: "agent_end", code: 0, signal: null });
  }

  async abort(): Promise<void> {
    this.streaming = false;
  }
  dispose(): void {
    disposedSessions++;
    this.emitter.removeAllListeners();
  }
  getModels(): ModelInfo[] {
    return [{ provider: "echo", id: "echo-mini", name: "Echo Mini" }];
  }
  getCurrentModel(): ModelInfo | undefined {
    return this._model;
  }
  async setModel(provider: string, id: string): Promise<void> {
    this._model = { provider, id, name: id };
  }
  getName(): string | undefined {
    return this._name;
  }
  setName(name: string): void {
    this._name = name;
  }
  async suggestName(): Promise<string | undefined> {
    return undefined;
  }
}

const ECHO_CAPS: RuntimeCapabilities = { toolInterception: true, modelSelection: true, packages: false, resume: true, fork: false };

class EchoRuntime implements AgentRuntime {
  readonly id = "echo";
  readonly displayName = "Echo";
  readonly capabilities = ECHO_CAPS;
  last?: EchoSession;
  async createSession(options: OpenSessionOptions): Promise<OpenSessionResult> {
    this.last = new EchoSession(options.workspace, options.toolInterceptor);
    return { session: this.last, warning: "echo warning" };
  }
  async openSession(options: OpenSessionOptions & { sessionFile: string }): Promise<OpenSessionResult> {
    return this.createSession(options);
  }
  async listSessions(): Promise<SessionSummary[]> {
    return [{ id: "echo-1" }];
  }
}

// ---- Fake ServiceConnection -------------------------------------------------

function fakeConn() {
  let inbound: ((m: ClientMessage) => void) | undefined;
  let onClose: (() => void) | undefined;
  const outbound: ServerMessage[] = [];
  let autoReply: ((m: ServerMessage) => void) | undefined;
  const conn: ServiceConnection = {
    send: (m) => {
      outbound.push(m);
      if (autoReply) setImmediate(() => autoReply?.(m));
    },
    onMessage: (h) => (inbound = h),
    onClose: (h) => (onClose = h),
    close: () => {},
  };
  return {
    conn,
    outbound,
    feed: (m: ClientMessage) => inbound?.(m),
    close: () => onClose?.(),
    setAutoReply: (fn: (m: ServerMessage) => void) => (autoReply = fn),
    events: () => outbound.filter((m): m is Extract<ServerMessage, { t: "event" }> => m.t === "event"),
    started: () => outbound.find((m): m is Extract<ServerMessage, { t: "started" }> => m.t === "started"),
  };
}

const flush = () => new Promise((r) => setImmediate(r));

function startFrame(over: Partial<Extract<ClientMessage, { t: "start" }>> = {}): ClientMessage {
  return { t: "start", id: 1, protocol: 1, runtime: "echo", op: "create", options: { workspace: "/tmp/ws" }, ...over };
}

test("start creates a session and returns an initial snapshot", async () => {
  const runtime = new EchoRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime });
  const c = fakeConn();
  service.accept(c.conn);
  c.feed(startFrame());
  await flush();
  const started = c.started();
  assert.ok(started, "a started frame was sent");
  assert.equal(started.snapshot.sessionId, "echo-1");
  assert.equal(started.snapshot.cwd, "/tmp/ws");
  assert.equal(started.snapshot.warning, "echo warning");
  assert.deepEqual(started.snapshot.capabilities, ECHO_CAPS);
  assert.equal(service.sessionCount, 1);
});

test("a prompt forwards the full event stream with a post-turn snapshot", async () => {
  const runtime = new EchoRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime });
  const c = fakeConn();
  service.accept(c.conn);
  c.feed(startFrame());
  await flush();
  c.feed({ t: "req", id: 2, method: "prompt", args: ["hi there", {}] });
  await flush();

  const types = c.events().map((m) => m.event.type);
  assert.deepEqual(types, ["agent_start", "turn_start", "message_start", "message_update", "message_end", "turn_end", "agent_end"]);

  // The agent_end frame must carry the post-turn state (sessionFile + messages),
  // so the daemon's mirror is correct at that boundary (matches process.ts).
  const endFrame = c.events().find((m) => m.event.type === "agent_end");
  assert.ok(endFrame?.snapshot, "agent_end carries a snapshot delta");
  assert.equal(endFrame.snapshot?.sessionFile, "/echo/echo-1.json");
  assert.deepEqual(endFrame.snapshot?.messages, [
    { role: "user", content: "hi there" },
    { role: "assistant", content: "hi there" },
  ]);
  assert.equal(endFrame.snapshot?.isStreaming, false);

  // The prompt req is acked.
  assert.ok(c.outbound.some((m) => m.t === "res" && m.id === 2 && m.ok));
});

test("tool interception round-trips to the daemon (reverse RPC)", async () => {
  const runtime = new EchoRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime });
  const c = fakeConn();
  service.accept(c.conn);
  // Auto-answer the service's intercept with a block decision.
  c.setAutoReply((m) => {
    if (m.t === "intercept") c.feed({ t: "intercept-res", id: m.id, decision: { block: true, reason: "denied" } });
  });
  c.feed(startFrame({ options: { workspace: "/tmp/ws", hasToolInterceptor: true } }));
  await flush();
  c.feed({ t: "req", id: 2, method: "prompt", args: ["run tool", {}] });
  await flush();
  await flush();

  assert.ok(c.outbound.some((m) => m.t === "intercept"), "the service asked the daemon to adjudicate");
  const endFrame = c.events().find((m) => m.event.type === "agent_end");
  // The block decision reached the runtime and shaped its output.
  assert.deepEqual(endFrame?.snapshot?.messages?.at(-1), { role: "assistant", content: "BLOCKED:denied" });
});

test("explicit dispose reaps the child and drops the session", async () => {
  disposedSessions = 0;
  const runtime = new EchoRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime });
  const c = fakeConn();
  service.accept(c.conn);
  c.feed(startFrame());
  await flush();
  c.feed({ t: "notify", method: "dispose", args: [] });
  await flush();
  assert.equal(disposedSessions, 1, "the real session was disposed");
  assert.equal(service.sessionCount, 0);
});

test("an unexpected disconnect DETACHES and keeps the child running", async () => {
  disposedSessions = 0;
  const runtime = new EchoRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime });
  const c = fakeConn();
  service.accept(c.conn);
  c.feed(startFrame());
  await flush();
  c.close(); // link drops without a dispose
  await flush();
  assert.equal(disposedSessions, 0, "the child was NOT reaped on disconnect");
  assert.equal(service.sessionCount, 1, "the session is kept for re-attach");
});

test("attach re-binds a detached session and resumes forwarding", async () => {
  const runtime = new EchoRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime });
  const c1 = fakeConn();
  service.accept(c1.conn);
  c1.feed(startFrame());
  await flush();
  const sessionId = c1.started()!.snapshot.sessionId;
  c1.close();
  await flush();

  // A fresh connection attaches by id.
  const c2 = fakeConn();
  service.accept(c2.conn);
  c2.feed({ t: "start", id: 1, protocol: 1, runtime: "echo", op: "attach", options: { sessionId } });
  await flush();
  assert.ok(c2.started(), "attach returns a fresh snapshot");
  // A prompt on the re-attached connection streams to c2, not c1.
  c2.feed({ t: "req", id: 5, method: "prompt", args: ["again", {}] });
  await flush();
  assert.ok(c2.events().some((m) => m.event.type === "agent_end"));
});

test("disposeAll reaps every live session (service shutdown)", async () => {
  disposedSessions = 0;
  const runtime = new EchoRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime });
  const c = fakeConn();
  service.accept(c.conn);
  c.feed(startFrame());
  await flush();
  service.disposeAll();
  assert.equal(disposedSessions, 1);
  assert.equal(service.sessionCount, 0);
});
