// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Issue #154: RuntimeCapabilities.streamingBehaviors is how a runtime tells
// the client whether an explicit mid-turn "steer" is safe to offer at all
// (AppController.supportsSteering / the composer's "Steer current turn"
// action). Built-in runtimes declare it statically; a protocol/RPC shim opts
// in via its hello (capabilitiesFromHello in src/runtime/protocol.ts) and
// defaults to none — an arbitrary shim must promise support before the client
// will ever try to interrupt it.
import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";

import { PiRuntime } from "../src/runtime/pi.js";
import { ClaudeCodeRuntime } from "../src/runtime/claude-code.js";
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
      if (event) {
        clearInterval(timer);
        resolve(event);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timed out waiting for protocol event"));
      }
    }, 10);
  });
}

test("Pi advertises both steer and followUp — its SDK implements both explicitly", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bivy-pi-caps-"));
  const runtime = new PiRuntime({ credsDir: dir, piDir: dir, sessionsDir: dir });
  assert.deepEqual(runtime.capabilities.streamingBehaviors, ["steer", "followUp"]);
});

test("Claude Code advertises steer only — it has no real deferred followUp, only immediate injection", () => {
  const runtime = new ClaudeCodeRuntime();
  assert.deepEqual(runtime.capabilities.streamingBehaviors, ["steer"]);
});

test("a protocol/RPC shim that says nothing about streaming behavior is treated as steer-unsupported (queue safely)", async () => {
  const runtime = new ProtocolRuntime({ command: process.execPath, args: [fixture], displayName: "Fixture Protocol" });
  const { session } = await runtime.createSession({ workspace: process.cwd() });
  assert.equal(runtime.capabilities.streamingBehaviors, undefined);
  session.dispose();
});

test("a protocol/RPC shim can opt into steer support via its hello", async () => {
  const runtime = new ProtocolRuntime({
    command: process.execPath,
    args: [fixture],
    displayName: "Fixture Protocol (steer)",
    env: { FIXTURE_STREAMING_BEHAVIORS: "steer" },
  });
  const { session } = await runtime.createSession({ workspace: process.cwd() });
  assert.deepEqual(runtime.capabilities.streamingBehaviors, ["steer"]);
  session.dispose();
});

test("a protocol/RPC shim advertising both is passed through in full", async () => {
  const runtime = new ProtocolRuntime({
    command: process.execPath,
    args: [fixture],
    displayName: "Fixture Protocol (both)",
    env: { FIXTURE_STREAMING_BEHAVIORS: "steer,followUp" },
  });
  const { session } = await runtime.createSession({ workspace: process.cwd() });
  assert.deepEqual(runtime.capabilities.streamingBehaviors, ["steer", "followUp"]);
  session.dispose();
});

test("a shim advertising only garbage values is treated as no support, not a crash", async () => {
  const runtime = new ProtocolRuntime({
    command: process.execPath,
    args: [fixture],
    displayName: "Fixture Protocol (garbage)",
    env: { FIXTURE_STREAMING_BEHAVIORS: "yolo,whenever" },
  });
  const { session } = await runtime.createSession({ workspace: process.cwd() });
  assert.equal(runtime.capabilities.streamingBehaviors, undefined);
  session.dispose();
});

test("the hint reaches the runtime end to end: an explicit steer forwards over the protocol as streamingBehavior: steer", async () => {
  const runtime = new ProtocolRuntime({
    command: process.execPath,
    args: [fixture],
    displayName: "Fixture Protocol (forward)",
    env: { FIXTURE_STREAMING_BEHAVIORS: "steer" },
  });
  const { session } = await runtime.createSession({ workspace: process.cwd() });
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.prompt("interrupt me", { streamingBehavior: "steer" });
  const received = await waitFor(events, (event) => event.type === "prompt.received");
  assert.equal((received as { streamingBehavior?: string }).streamingBehavior, "steer");
  session.dispose();
});
