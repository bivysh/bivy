// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Dead-child self-heal for every protocol agent (opencode/ACP, Codex, Gemini).
//
// Reproduces the staging failure: an opencode turn wedged (its provider hit a
// rate-limit/endpoint outage and never resolved session/prompt), the daemon's
// turn-watchdog SIGKILL'd the child to recover it — and then EVERY later action
// on that session threw "Protocol agent is not running." because ProtocolSession
// kept a handle to the dead child and never respawned. The session was pinned
// permanently unresumable ("Send a message to continue" → "Protocol agent is not
// running.") until the whole chat was abandoned.
//
// The fix (src/runtime/protocol.ts): when the child exits, forget it AND the
// "session opened" flag, so the next prompt() respawns the shim and re-resumes
// the agent's own session by its runtimeSessionRef. This test kills the live
// child mid-life and asserts the very next prompt transparently respawns a NEW
// child, resumes (not recreates) the same agent session, and completes.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolRuntime } from "../src/runtime/protocol.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, "fixtures/protocol-agent.mjs");

function waitFor(events: RuntimeEvent[], pred: (event: RuntimeEvent) => boolean, timeoutMs = 3000): Promise<RuntimeEvent> {
  const existing = events.find(pred);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const event = events.find(pred);
      if (event) { clearInterval(timer); resolve(event); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error("timed out waiting for protocol event")); }
    }, 10);
  });
}

// `resumable: true` forces capabilities.resume on, exactly as the opencode/ACP
// and Codex catalog entries do — so open() prefers session.resume after a
// respawn instead of forking a fresh session.
const runtime = new ProtocolRuntime({ command: process.execPath, args: [fixture], displayName: "Fixture Protocol", resumable: true });
const { session } = await runtime.createSession({
  workspace: process.cwd(),
  toolInterceptor: async () => undefined,
});
assert.equal(runtime.capabilities.resume, true, "resumable runtime advertises resume up front");

const events: RuntimeEvent[] = [];
session.subscribe((event) => events.push(event));

// Turn 1: a normal prompt that opens the agent session (session.create) and
// completes. This is what establishes the runtimeSessionRef the respawn resumes.
await session.prompt("first");
await waitFor(events, (e) => e.type === "agent_end");
const firstPid = session.activePid();
assert.ok(typeof firstPid === "number" && firstPid > 0, "a live child backs the first turn");
const refAfterCreate = session.sessionFile;
assert.ok(refAfterCreate, "session.create yielded an agent session ref to resume later");

// Simulate the watchdog's recovery kill of a wedged agent: SIGKILL the live
// child out from under the session, then wait for the runtime to observe the
// exit (the 'close' handler that forgets the dead child). Clear events first so
// the wait can't match turn 1's stale agent_end.
events.length = 0;
process.kill(firstPid!, "SIGKILL");
await waitFor(events, (e) => e.type === "agent_end", 3000); // close → agent_end

// Turn 2: the crucial assertion. Before the fix this threw "Protocol agent is
// not running." Now it must transparently respawn a fresh child, resume the SAME
// agent session (the fixture answers session.resume with a session.resumed
// event), and complete the turn.
events.length = 0;
await session.prompt("second");
await waitFor(events, (e) => e.type === "agent_end", 5000);

const resumed = events.find((e) => (e as { type: string }).type === "session.resumed") as { runtimeSessionRef?: string } | undefined;
assert.ok(resumed, "the respawn resumed the agent session (session.resume), it did not silently fork a fresh one");
assert.equal(resumed!.runtimeSessionRef, refAfterCreate, "resumed the same agent session ref established on create");

const secondPid = session.activePid();
assert.ok(typeof secondPid === "number" && secondPid > 0, "a fresh child backs the recovered turn");
assert.notEqual(secondPid, firstPid, "the recovered turn runs on a NEWLY spawned child, not the dead one");

// The recovered turn produced real assistant output — the session is genuinely
// usable again, not merely alive.
assert.ok(session.getMessages().some((m) => m.role === "assistant"), "recovered turn streamed an assistant reply");

// An abort against an already-dead child must settle silently, never reject with
// "Protocol agent is not running." (the unhandled rejection seen in staging).
process.kill(session.activePid()!, "SIGKILL");
await waitFor(events, (e) => e.type === "agent_end", 3000);
await session.abort(); // must not throw

session.dispose();
console.log("protocol-runtime-recover: ok");
