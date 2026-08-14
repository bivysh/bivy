// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Regression for the Codex app-server shim's turn-termination. A Codex turn that
// ends in `turn/failed` is TERMINAL — no `turn/completed` follows it. The shim
// used to only stash that error and wait for a completion event that never came,
// so ProtocolRuntime never emitted `agent_end` and the daemon pinned the session
// "working" until the stall watchdog force-recovered it minutes later (the "Codex
// keeps getting stuck, I have to prompt it again" symptom). The shim now surfaces
// the error AND ends the turn immediately.
//
// Driven through the REAL shim (bin/codex-app-server-shim.mjs) over a fake
// app-server (test/fixtures/fake-codex-app-server.mjs), so it needs neither a
// Codex install nor model credentials — it always runs.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ProtocolRuntime } from "../src/runtime/protocol.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shim = path.join(__dirname, "..", "bin", "codex-app-server-shim.mjs");
const fakeAppServer = path.join(__dirname, "fixtures", "fake-codex-app-server.mjs");
// The shim spawns `$BIVY_CODEX_BIN app-server` directly (no shell), so the fake
// must be executable regardless of how the tree was checked out.
chmodSync(fakeAppServer, 0o755);

function waitFor(events: RuntimeEvent[], pred: (event: RuntimeEvent) => boolean, timeoutMs = 10_000): Promise<RuntimeEvent> {
  const existing = events.find(pred);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const event = events.find(pred);
      if (event) { clearInterval(timer); resolve(event); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error("timed out waiting for codex shim event")); }
    }, 25);
  });
}

function makeRuntime(mode: "ok" | "fail"): ProtocolRuntime {
  return new ProtocolRuntime({
    id: "codex-approvals",
    displayName: "Codex",
    command: process.execPath,
    args: [shim],
    env: { BIVY_CODEX_BIN: fakeAppServer, FAKE_CODEX_MODE: mode },
    capabilities: { toolInterception: true },
    resumable: true,
  });
}

test("a failed Codex turn ends the turn (agent_end + session.error), not left wedged", async () => {
  const runtime = makeRuntime("fail");
  const { session } = await runtime.createSession({
    workspace: process.cwd(),
    toolInterceptor: async () => undefined,
  });
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));

  await session.prompt("trigger a failure");
  await waitFor(events, (event) => event.type === "agent_end");

  const error = events.find((event) => event.type === "session.error") as { error?: string } | undefined;
  assert.ok(error, "a failed turn surfaces a session.error");
  assert.match(String(error?.error ?? ""), /simulated codex failure/, "the error carries the app-server failure message");
  assert.ok(events.some((event) => event.type === "agent_end"), "the turn terminates with agent_end so the daemon clears 'working'");
  // isStreaming must settle to false — a stuck-true bit is exactly what pins a
  // session busy and makes the next message vanish into a dead turn.
  assert.equal(session.isStreaming, false, "isStreaming is cleared after a failed turn");

  session.dispose();
});

test("a normal Codex turn still completes cleanly (agent_end, reply, no error)", async () => {
  const runtime = makeRuntime("ok");
  const { session } = await runtime.createSession({
    workspace: process.cwd(),
    toolInterceptor: async () => undefined,
  });
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));

  await session.prompt("say the word");
  await waitFor(events, (event) => event.type === "agent_end");

  assert.ok(!events.some((event) => event.type === "session.error"), "a clean turn emits no session.error");
  const reply = session.getMessages().map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  assert.match(reply, /BANANA/, "the assistant reply is captured");
  assert.equal(session.isStreaming, false, "isStreaming is cleared after a completed turn");

  session.dispose();
});
