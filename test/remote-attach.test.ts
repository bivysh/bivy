// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { AgentService } from "../src/runtime/agent-service.js";
import { RemoteRuntime, RemoteRuntimeSession } from "../src/runtime/remote.js";
import type { ToolCallDecision } from "../src/runtime/types.js";
import { EchoRuntime } from "./helpers/echo-runtime.js";
import { memoryPair } from "./helpers/memory-transport.js";

const tick = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

function daemon(runtime: EchoRuntime, connect: () => Promise<import("../src/runtime/remote.js").RpcTransport>) {
  return new RemoteRuntime({ targetRuntime: "echo", displayName: "Echo", capabilities: runtime.capabilities, connect });
}

/**
 * The core Stage 2 statelessness claim at the runtime layer: because the agent
 * service keeps a session's child alive across a daemon disconnect ("detach &
 * keep running"), a DIFFERENT daemon that knows the session id can re-attach to
 * the same live session and continue it — no in-process handle, no local disk.
 */
test("a second daemon attaches to a live session the first created and continues it", async () => {
  const runtime = new EchoRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime });

  // --- Daemon A creates the session and drives a turn (with the guardian). ----
  const seenByA: string[] = [];
  const pairA = memoryPair();
  service.accept(pairA.server);
  const daemonA = daemon(runtime, async () => pairA.client);
  const { session: sessA } = await daemonA.createSession({
    workspace: "/tmp/ws",
    toolInterceptor: (ctx): ToolCallDecision => {
      seenByA.push(ctx.toolName);
      return {};
    },
  });
  const sid = sessA.id;
  const eventsA: string[] = [];
  sessA.subscribe((e) => eventsA.push(e.type));
  await sessA.prompt("first turn");
  await tick();
  assert.ok(eventsA.includes("agent_end"), "daemon A saw the turn complete");
  assert.deepEqual(seenByA, ["Echo"], "daemon A's guardian adjudicated the tool");
  assert.equal(runtime.sessions.length, 1);
  assert.equal(runtime.sessions[0]!.turns, 1);

  // --- Daemon A disconnects WITHOUT dispose (crash / hand-off). ---------------
  pairA.client.close();
  await tick();
  assert.equal(service.sessionCount, 1, "the service kept the session alive");
  assert.equal(runtime.sessions[0]!.disposed, false, "the child was NOT reaped");

  // --- Daemon B attaches by id and continues the SAME session. ----------------
  const seenByB: string[] = [];
  const pairB = memoryPair();
  service.accept(pairB.server);
  const daemonB = daemon(runtime, async () => pairB.client);
  const { session: sessB } = await daemonB.attachSession(sid, {
    toolInterceptor: (ctx): ToolCallDecision => {
      seenByB.push(ctx.toolName);
      return {};
    },
  });
  assert.equal(sessB.id, sid, "attached to the same session id");
  assert.equal(sessB.getMessages().length, 2, "the first turn's transcript carried over on attach");

  const eventsB: string[] = [];
  sessB.subscribe((e) => eventsB.push(e.type));
  await sessB.prompt("second turn");
  await tick();
  assert.ok(eventsB.includes("agent_end"), "daemon B saw the second turn complete");
  assert.deepEqual(seenByB, ["Echo"], "daemon B's guardian now adjudicates — handoff complete");
  assert.equal(runtime.sessions.length, 1, "attach did NOT create a new session");
  assert.equal(runtime.sessions[0]!.turns, 2, "the same underlying session advanced to turn 2");
  assert.equal(sessB.getMessages().length, 4);
});

test("detach() keeps the session alive on the service; dispose() reaps it", async () => {
  const runtime = new EchoRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime });

  const pairA = memoryPair();
  service.accept(pairA.server);
  const daemonA = daemon(runtime, async () => pairA.client);
  const { session: sessA } = await daemonA.createSession({ workspace: "/tmp/ws" });
  const sid = sessA.id;

  // detach: drop the local handle WITHOUT reaping.
  (sessA as RemoteRuntimeSession).detach();
  await tick();
  assert.equal(service.sessionCount, 1, "detach kept the session");
  assert.equal(runtime.sessions[0]!.disposed, false, "detach did NOT reap the child");

  // Re-attach and this time dispose — which DOES reap.
  const pairB = memoryPair();
  service.accept(pairB.server);
  const daemonB = daemon(runtime, async () => pairB.client);
  const { session: sessB } = await daemonB.attachSession(sid);
  assert.equal(sessB.id, sid);
  sessB.dispose();
  await tick();
  assert.equal(service.sessionCount, 0, "dispose reaped the session");
  assert.equal(runtime.sessions[0]!.disposed, true);
});

test("attaching to an unknown session id fails cleanly", async () => {
  const runtime = new EchoRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime });
  const pair = memoryPair();
  service.accept(pair.server);
  const d = daemon(runtime, async () => pair.client);
  await assert.rejects(d.attachSession("does-not-exist"), /No detached session to attach/);
});
