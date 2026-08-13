// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// A protocol/ACP agent that does NOT gate tool calls (toolInterception:false —
// e.g. a third-party ACP agent running its own tools) must STILL stream its tool
// activity live. The `tool_call` event used to be emitted only inside the
// interception branch, so an ungoverned agent's cards appeared only after the
// turn ended and history reconciled. This pins the fix: the live card streams
// for every protocol agent, carrying its normalized detail, with no interceptor
// round-trip when interception is off.
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

const runtime = new ProtocolRuntime({
  command: process.execPath,
  args: [fixture],
  env: { FIXTURE_NO_INTERCEPTION: "1" },
  displayName: "Ungoverned Fixture",
});

const decisions: unknown[] = [];
const { session } = await runtime.createSession({
  workspace: process.cwd(),
  toolInterceptor: async (ctx) => { decisions.push(ctx); return undefined; },
});

assert.equal(runtime.capabilities.toolInterception, false, "fixture advertises no tool interception");

const events: RuntimeEvent[] = [];
session.subscribe((event) => events.push(event));
await session.prompt("run a tool");
await waitFor(events, (event) => event.type === "agent_end");

const toolCall = events.find((event) => event.type === "tool_call") as (RuntimeEvent & { toolName?: string; detail?: { kind?: string } }) | undefined;
assert.ok(toolCall, "the tool_call streamed live even though the agent doesn't gate tools");
assert.equal(toolCall?.toolName, "shell", "the call carries its tool name");
assert.equal(toolCall?.detail?.kind, "shell", "the normalized ToolCallDetail rode along for identical rendering");

assert.equal(decisions.length, 0, "no interceptor round-trip happens when interception is off");

// The tool still completes and the turn ends cleanly (the agent ran it itself).
assert.ok(events.some((event) => event.type === "tool_result"), "the tool result streamed too");

session.dispose();
console.log("protocol-runtime-tool-stream: ok");
