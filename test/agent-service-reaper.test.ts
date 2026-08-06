// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Service-side idle-reaper (Stage 3 of docs/agent-node-decoupling.md): under the
// "detach & keep running" policy a session the daemon evicts/loses persists on the
// agent service forever. The reaper bounds that — reaping a DETACHED, IDLE session
// after a TTL — while never touching an attached or streaming one. Driven by an
// injected clock, so it's deterministic without real time.

import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import test from "node:test";

import { AgentService } from "../src/runtime/agent-service.js";
import { RemoteRuntime, type RpcTransport } from "../src/runtime/remote.js";
import type { AgentRuntime, ModelInfo, OpenSessionOptions, OpenSessionResult, RuntimeEvent, RuntimeMessage, RuntimeSession, SessionSummary } from "../src/runtime/types.js";
import { EchoRuntime } from "./helpers/echo-runtime.js";
import { memoryPair } from "./helpers/memory-transport.js";

const tick = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

/** Deterministic clock: schedule/cancel one-shot timers, fire them as time advances. */
class FakeClock {
  private t = 0;
  private scheduled: { at: number; fn: () => void; h: symbol; live: boolean }[] = [];
  now = () => this.t;
  timers = {
    schedule: (fn: () => void, ms: number) => {
      const h = Symbol();
      this.scheduled.push({ at: this.t + ms, fn, h, live: true });
      return h;
    },
    cancel: (h: symbol) => {
      const e = this.scheduled.find((s) => s.h === h);
      if (e) e.live = false;
    },
  };
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.scheduled.filter((s) => s.live && s.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.live = false;
      this.t = due.at; // observe time AT the scheduled tick, so re-arm is relative to it
      due.fn();
    }
    this.t = target;
  }
}

function daemonRuntime(runtime: AgentRuntime, connect: () => Promise<RpcTransport>) {
  return new RemoteRuntime({ targetRuntime: runtime.id, displayName: "X", capabilities: runtime.capabilities, connect });
}

test("reaper OFF by default: a detached session persists (no TTL configured)", async () => {
  const runtime = new EchoRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime }); // no detachReapMs
  const pair = memoryPair();
  service.accept(pair.server);
  const { session } = await daemonRuntime(runtime, async () => pair.client).createSession({ workspace: "/tmp/ws" });
  void session;
  pair.client.close();
  await tick();
  assert.equal(service.sessionCount, 1, "with the reaper off, a detached session is kept indefinitely");
});

test("a detached, idle session is reaped after the TTL", async () => {
  const clock = new FakeClock();
  const runtime = new EchoRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime, detachReapMs: 1000, timers: clock.timers, now: clock.now });
  const pair = memoryPair();
  service.accept(pair.server);
  await daemonRuntime(runtime, async () => pair.client).createSession({ workspace: "/tmp/ws" });
  await tick();

  clock.advance(500); // one sweep, but not yet idle past TTL, and still attached
  assert.equal(service.sessionCount, 1);

  pair.client.close(); // detach at t=500
  await tick();
  assert.equal(service.sessionCount, 1, "kept alive immediately after detach");

  clock.advance(400); // t=900; no qualifying sweep yet (idle < TTL)
  assert.equal(service.sessionCount, 1, "not reaped shortly after detach");

  clock.advance(1200); // t=2100; a sweep at t=1500 sees idle 1000 >= TTL
  assert.equal(service.sessionCount, 0, "reaped once detached-idle past the TTL");
  assert.equal(runtime.sessions[0]!.disposed, true, "the child was reaped");
});

test("an ATTACHED session is never reaped, however long it idles", async () => {
  const clock = new FakeClock();
  const runtime = new EchoRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime, detachReapMs: 1000, timers: clock.timers, now: clock.now });
  const pair = memoryPair();
  service.accept(pair.server);
  await daemonRuntime(runtime, async () => pair.client).createSession({ workspace: "/tmp/ws" });
  await tick();
  clock.advance(100_000); // stays connected the whole time
  assert.equal(service.sessionCount, 1, "an attached session is exempt from the reaper");
});

// A runtime whose session stays `isStreaming` until we flip it — to prove the
// reaper won't kill a live turn even if the daemon has vanished.
class HangSession implements RuntimeSession {
  readonly id = "hang-1";
  readonly cwd = "/tmp/ws";
  private readonly emitter = new EventEmitter();
  streaming = false;
  disposed = false;
  get sessionFile() {
    return undefined;
  }
  get isStreaming() {
    return this.streaming;
  }
  activePid() {
    return this.streaming ? 1 : undefined;
  }
  getMessages(): RuntimeMessage[] {
    return [];
  }
  subscribe(listener: (event: RuntimeEvent) => void) {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
  async prompt(): Promise<void> {
    this.streaming = true; // starts a turn and stays streaming (never emits agent_end)
    this.emitter.emit("event", { type: "agent_start" });
  }
  async abort(): Promise<void> {
    this.streaming = false;
  }
  dispose(): void {
    this.disposed = true;
  }
  getModels(): ModelInfo[] {
    return [];
  }
  getCurrentModel(): ModelInfo | undefined {
    return undefined;
  }
  async setModel(): Promise<void> {}
  getName(): string | undefined {
    return undefined;
  }
  setName(): void {}
  async suggestName(): Promise<string | undefined> {
    return undefined;
  }
}
class HangRuntime implements AgentRuntime {
  readonly id = "hang";
  readonly displayName = "Hang";
  readonly capabilities = { toolInterception: false, modelSelection: false, packages: false, resume: false, fork: false };
  readonly sessions: HangSession[] = [];
  async createSession(_options: OpenSessionOptions): Promise<OpenSessionResult> {
    const session = new HangSession();
    this.sessions.push(session);
    return { session };
  }
  async openSession(options: OpenSessionOptions & { sessionFile: string }): Promise<OpenSessionResult> {
    return this.createSession(options);
  }
  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }
}

test("a detached but STREAMING session is spared until the turn ends", async () => {
  const clock = new FakeClock();
  const runtime = new HangRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime, detachReapMs: 1000, timers: clock.timers, now: clock.now });
  const pair = memoryPair();
  service.accept(pair.server);
  const { session } = await daemonRuntime(runtime, async () => pair.client).createSession({ workspace: "/tmp/ws" });
  await session.prompt("go"); // starts a turn; stays streaming
  await tick();

  pair.client.close(); // detach mid-turn
  await tick();
  clock.advance(5000); // way past the TTL, but still streaming
  assert.equal(service.sessionCount, 1, "a live turn is never reaped, even detached past the TTL");

  runtime.sessions[0]!.streaming = false; // the turn finishes service-side
  clock.advance(1000); // now idle past the TTL
  assert.equal(service.sessionCount, 0, "reaped once the turn ends and it goes idle");
});

test("re-attach resets the idle clock", async () => {
  const clock = new FakeClock();
  const runtime = new EchoRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime, detachReapMs: 1000, timers: clock.timers, now: clock.now });
  const pairA = memoryPair();
  service.accept(pairA.server);
  const { session } = await daemonRuntime(runtime, async () => pairA.client).createSession({ workspace: "/tmp/ws" });
  const sid = session.id;
  await tick();

  pairA.client.close(); // detach at t=0
  await tick();
  clock.advance(600); // idle 600 < 1000 → still alive
  assert.equal(service.sessionCount, 1);

  // Re-attach at t=600 — resets lastActiveAt.
  const pairB = memoryPair();
  service.accept(pairB.server);
  await daemonRuntime(runtime, async () => pairB.client).attachSession(sid);
  await tick();
  pairB.client.close(); // detach again at t=600
  await tick();

  clock.advance(700); // t=1300; idle since re-attach = 700 < 1000 → NOT reaped
  assert.equal(service.sessionCount, 1, "the clock restarted at re-attach, so it isn't reaped yet");

  clock.advance(1200); // t=2500; a sweep at t=2000 sees idle 1400 >= TTL from the re-attach
  assert.equal(service.sessionCount, 0, "reaped once idle past the TTL from the re-attach");
});
