// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import test from "node:test";

import { AgentService } from "../src/runtime/agent-service.js";
import { RemoteRuntime } from "../src/runtime/remote.js";
import type {
  AgentRuntime,
  OpenSessionOptions,
  OpenSessionResult,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeMessage,
  RuntimeSession,
  SessionSummary,
  ToolProvider,
} from "../src/runtime/types.js";
import { memoryPair } from "./helpers/memory-transport.js";

const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

const CAPS: RuntimeCapabilities = { toolInterception: false, modelSelection: false, packages: false, resume: true, fork: false };

/**
 * A minimal runtime whose agent, on each prompt, calls ONE node-hosted tool from
 * its toolProvider and echoes the result into the transcript. It stands in for a
 * real agent (pi/claude/…) so the reverse-RPC tool path is exercised without any
 * agent SDK — proving the seam is agent-agnostic.
 */
class ToolCallingSession implements RuntimeSession {
  readonly id: string;
  private readonly emitter = new EventEmitter();
  private streaming = false;
  private messages: RuntimeMessage[] = [];
  disposed = false;
  /** Tool specs the agent was offered at session start. */
  readonly offeredTools: string[];

  constructor(readonly cwd: string, id: string, private readonly provider?: ToolProvider) {
    this.id = id;
    this.offeredTools = provider ? provider.list().map((s) => s.name) : [];
  }

  get sessionFile() { return undefined; }
  get isStreaming() { return this.streaming; }
  activePid() { return this.streaming ? 999 : undefined; }
  getMessages() { return this.messages; }
  subscribe(l: (e: RuntimeEvent) => void) { this.emitter.on("event", l); return () => this.emitter.off("event", l); }
  private emit(e: RuntimeEvent) { this.emitter.emit("event", e); }

  async prompt(text: string): Promise<void> {
    this.streaming = true;
    this.messages.push({ role: "user", content: text });
    this.emit({ type: "agent_start" });
    this.emit({ type: "turn_start" });
    this.emit({ type: "message_start", message: { role: "assistant", content: "" } });
    let reply = text;
    if (this.provider) {
      const spec = this.provider.list()[0];
      if (spec) {
        const result = await this.provider.invoke(spec.name, "call-1", { text });
        reply = result.content?.[0]?.text ?? "(no content)";
        if (result.isError) reply = `ERROR:${reply}`;
      }
    }
    this.emit({ type: "message_update", message: { role: "assistant", content: reply } });
    const message = { role: "assistant", content: reply };
    this.messages.push(message);
    this.streaming = false;
    this.emit({ type: "message_end", message });
    this.emit({ type: "turn_end" });
    this.emit({ type: "agent_end", code: 0, signal: null });
  }

  async abort(): Promise<void> { this.streaming = false; }
  dispose(): void { this.disposed = true; this.emitter.removeAllListeners(); }
  getName() { return undefined; }
  setName() {}
  async suggestName() { return undefined; }
  getModels() { return []; }
  getCurrentModel() { return undefined; }
  async setModel() {}
}

class ToolCallingRuntime implements AgentRuntime {
  readonly id = "tool-agent";
  readonly displayName = "Tool Agent";
  readonly capabilities = CAPS;
  readonly sessions: ToolCallingSession[] = [];
  private seq = 0;

  async createSession(options: OpenSessionOptions): Promise<OpenSessionResult> {
    const s = new ToolCallingSession(options.workspace, `s-${++this.seq}`, options.toolProvider);
    this.sessions.push(s);
    return { session: s };
  }
  async openSession(options: OpenSessionOptions & { sessionFile: string }): Promise<OpenSessionResult> {
    return this.createSession(options);
  }
  async listSessions(): Promise<SessionSummary[]> {
    return this.sessions.map((s) => ({ id: s.id, cwd: s.cwd, messageCount: s.getMessages().length }));
  }
}

function daemon(runtime: AgentRuntime, connect: () => Promise<import("../src/runtime/remote.js").RpcTransport>) {
  return new RemoteRuntime({ targetRuntime: "tool-agent", displayName: "Tool Agent", capabilities: runtime.capabilities, connect });
}

/**
 * The core Slice-1 claim: a service-hosted agent is OFFERED the daemon's tools
 * (specs cross the link), and when it CALLS one the tool executes back on the
 * DAEMON (reverse RPC), with the result returned to the agent. Nothing on the
 * link knows which agent it is — the seam is agent-agnostic.
 */
test("a service-hosted agent invokes a node-hosted tool that runs on the daemon", async () => {
  const runtime = new ToolCallingRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime });
  const pair = memoryPair();
  service.accept(pair.server);

  const ranOnDaemon: Array<{ name: string; toolCallId: string; params: unknown }> = [];
  const provider: ToolProvider = {
    list: () => [{ name: "lookup", description: "look something up", parameters: { type: "object" } }],
    invoke: async (name, toolCallId, params) => {
      ranOnDaemon.push({ name, toolCallId, params });
      return { content: [{ type: "text", text: `daemon-ran:${JSON.stringify(params)}` }] };
    },
  };

  const d = daemon(runtime, async () => pair.client);
  const { session } = await d.createSession({ workspace: "/tmp/ws", toolProvider: provider });
  await session.prompt("hello");
  await tick();

  // The agent (on the service) was offered the tool spec.
  assert.deepEqual(runtime.sessions[0]!.offeredTools, ["lookup"], "the hosted agent saw the tool");
  // The tool executed on the DAEMON, not the service (reverse RPC).
  assert.equal(ranOnDaemon.length, 1, "the daemon's provider ran exactly once");
  assert.equal(ranOnDaemon[0]!.name, "lookup");
  assert.deepEqual(ranOnDaemon[0]!.params, { text: "hello" });
  // The result flowed back into the agent's transcript.
  assert.match(String(session.getMessages().at(-1)!.content), /daemon-ran:\{"text":"hello"\}/);
});

test("no provider → the agent is offered no extra tools (default path unchanged)", async () => {
  const runtime = new ToolCallingRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime });
  const pair = memoryPair();
  service.accept(pair.server);

  const d = daemon(runtime, async () => pair.client);
  const { session } = await d.createSession({ workspace: "/tmp/ws" });
  await session.prompt("hi");
  await tick();

  assert.deepEqual(runtime.sessions[0]!.offeredTools, [], "no toolProvider ⇒ no extra tools");
  assert.equal(String(session.getMessages().at(-1)!.content), "hi");
});

/**
 * After a daemon hands off (detach + re-attach by another daemon), a tool call
 * must run on the daemon that is CURRENTLY attached — its credentials, its
 * provider — never the departed one. This is the tool-side of the Stage 2 attach
 * guarantee.
 */
test("after re-attach, tool calls route to the newly-attached daemon's provider", async () => {
  const runtime = new ToolCallingRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime });

  const aCalls: unknown[] = [];
  const bCalls: unknown[] = [];
  const providerA: ToolProvider = {
    list: () => [{ name: "t", parameters: { type: "object" } }],
    invoke: async (_n, _id, params) => { aCalls.push(params); return { content: [{ type: "text", text: "from-A" }] }; },
  };
  const providerB: ToolProvider = {
    list: () => [{ name: "t", parameters: { type: "object" } }],
    invoke: async (_n, _id, params) => { bCalls.push(params); return { content: [{ type: "text", text: "from-B" }] }; },
  };

  const pairA = memoryPair();
  service.accept(pairA.server);
  const dA = daemon(runtime, async () => pairA.client);
  const { session: sA } = await dA.createSession({ workspace: "/tmp/ws", toolProvider: providerA });
  await sA.prompt("one");
  await tick();
  assert.equal(aCalls.length, 1, "daemon A's provider ran the first call");
  assert.match(String(sA.getMessages().at(-1)!.content), /from-A/);
  const sid = sA.id;

  // Daemon A vanishes (crash / hand-off) — detach, keep the session alive.
  pairA.client.close();
  await tick();
  assert.equal(service.sessionCount, 1, "the session survived the disconnect");

  // Daemon B attaches with ITS OWN provider and continues.
  const pairB = memoryPair();
  service.accept(pairB.server);
  const dB = daemon(runtime, async () => pairB.client);
  const { session: sB } = await dB.attachSession(sid, { toolProvider: providerB });
  await sB.prompt("two");
  await tick();

  assert.equal(bCalls.length, 1, "the re-attached daemon's provider ran the tool");
  assert.equal(aCalls.length, 1, "the departed daemon's provider was NOT used");
  assert.match(String(sB.getMessages().at(-1)!.content), /from-B/);
});

/**
 * A detached session (no bound daemon) cannot run a node-hosted tool — its
 * implementation lives on the vanished daemon — so the call is denied, not hung.
 */
test("a tool call with no attached daemon is denied cleanly", async () => {
  const runtime = new ToolCallingRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime });
  const pair = memoryPair();
  service.accept(pair.server);

  const provider: ToolProvider = {
    list: () => [{ name: "t", parameters: { type: "object" } }],
    invoke: async () => ({ content: [{ type: "text", text: "should-not-run" }] }),
  };
  const d = daemon(runtime, async () => pair.client);
  await d.createSession({ workspace: "/tmp/ws", toolProvider: provider });
  const svcSession = runtime.sessions[0]!;

  // Simulate the daemon vanishing, then have the agent try to call the tool.
  pair.client.close();
  await tick();
  // Reach into the hosted session's proxy provider (what the real agent would call).
  const proxy = (svcSession as unknown as { provider?: ToolProvider }).provider;
  assert.ok(proxy, "the hosted session has a proxy provider");
  const result = await proxy!.invoke("t", "call-x", { text: "x" });
  assert.equal(result.isError, true, "the call is denied");
  assert.match(String(result.content?.[0]?.text), /disconnected/);
});
