// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Startup-adoption round-trip at the runtime layer (Stage 3 of
// docs/agent-node-decoupling.md): a fresh daemon re-attaches to a session a dead
// daemon left running on the agent service, by (a) looking the address up from a
// control-plane-shaped source and (b) routing an attach at that address. Ties
// ControlPlaneSessionLocationRegistry + attachAdoptedSessions + RemoteRuntime
// against a REAL AgentService — no server.ts, no socket.

import { strict as assert } from "node:assert";
import test from "node:test";

import { AgentService } from "../src/runtime/agent-service.js";
import { RemoteRuntime, RemoteRuntimeSession, type RpcTransport } from "../src/runtime/remote.js";
import { attachAdoptedSessions } from "../src/runtime/adoption.js";
import { ControlPlaneSessionLocationRegistry } from "../src/runtime/control-plane-location.js";
import type { RuntimeSession } from "../src/runtime/types.js";
import { EchoRuntime } from "./helpers/echo-runtime.js";
import { memoryPair } from "./helpers/memory-transport.js";

const tick = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

/** A tiny "service directory": every address dials the one in-process service. */
function serviceDirectory(service: AgentService): (addr: string) => Promise<RpcTransport> {
  return async () => {
    const pair = memoryPair();
    service.accept(pair.server);
    return pair.client;
  };
}

function remoteAt(runtime: EchoRuntime, addr: string, connect: () => Promise<RpcTransport>) {
  return new RemoteRuntime({ targetRuntime: "echo", displayName: "Echo", capabilities: runtime.capabilities, agentServiceAddress: addr, connect });
}

test("a fresh daemon adopts a session a dead daemon left running, routed by its address", async () => {
  const runtime = new EchoRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime });
  const dial = serviceDirectory(service);

  // --- Daemon A creates the session at addr-1, runs a turn, then DIES (detach). --
  const runtimeA = remoteAt(runtime, "addr-1", () => dial("addr-1"));
  const { session: sessA } = await runtimeA.createSession({ workspace: "/tmp/ws" });
  const sid = sessA.id;
  await sessA.prompt("first turn");
  await tick();
  (sessA as RemoteRuntimeSession).detach();
  await tick();
  assert.equal(service.sessionCount, 1, "the service kept the child alive after A died");

  // --- Daemon B boots. Adoption resolves the address from the control plane... --
  const cp = new ControlPlaneSessionLocationRegistry({
    fetchNodeSessions: async () => [{ sessionId: sid, agentServiceAddress: "addr-1" }],
    resolveRuntimeId: () => "echo",
    nodeId: "node-b",
  });
  const rows = await cp.listNode();
  assert.deepEqual(rows.map((r) => r.sessionId), [sid], "address resolved for adoption");

  // --- ...then attaches at that address, per-session-routed. --------------------
  const adopted: RuntimeSession[] = [];
  const outcome = await attachAdoptedSessions(rows, {
    attach: async (loc) => {
      const rt = remoteAt(runtime, loc.agentServiceAddress, () => dial(loc.agentServiceAddress));
      const { session } = await rt.attachSession(loc.sessionId);
      adopted.push(session);
    },
    forget: async () => {},
  });

  assert.deepEqual(outcome.adopted, [sid]);
  assert.equal(adopted[0]!.id, sid, "adopted the same session id");
  assert.equal(adopted[0]!.getMessages().length, 2, "the first turn's transcript carried over");
  await adopted[0]!.prompt("second turn");
  await tick();
  assert.equal(runtime.sessions.length, 1, "adoption did NOT spawn a new child");
  assert.equal(runtime.sessions[0]!.turns, 2, "the same underlying session advanced");
});

test("adoption forgets a definitively-gone session (verifies the real wire error classifies as 'gone')", async () => {
  const runtime = new EchoRuntime();
  const service = new AgentService({ runtimeProvider: () => runtime }); // no such session
  const dial = serviceDirectory(service);
  const forgotten: string[] = [];

  const outcome = await attachAdoptedSessions(
    [{ sessionId: "ghost", agentServiceAddress: "addr-1", runtimeId: "echo" }],
    {
      attach: async (loc) => {
        const rt = remoteAt(runtime, loc.agentServiceAddress, () => dial(loc.agentServiceAddress));
        await rt.attachSession(loc.sessionId); // service replies "No detached session to attach"
      },
      forget: async (id) => void forgotten.push(id),
    },
  );

  assert.deepEqual(outcome.forgotten, ["ghost"], "the real attach-reject was classified as definitively gone");
  assert.deepEqual(outcome.adopted, []);
  assert.deepEqual(forgotten, ["ghost"]);
});
