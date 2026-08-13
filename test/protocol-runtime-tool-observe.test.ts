// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Some upstream runtimes report tool activity only once it has begun. Codex's
// app-server does this for MCP, dynamic, and collaboration/sub-agent items.
// Such activity must render and persist, but must not open an approval that can
// no longer stop it.
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
      if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error("timed out waiting for observed tool")); }
    }, 10);
  });
}

const runtime = new ProtocolRuntime({
  id: "codex-observe-fixture",
  command: process.execPath,
  args: [fixture],
  env: { FIXTURE_OBSERVED_TOOL: "1" },
  displayName: "Observed Tool Fixture",
});

const decisions: unknown[] = [];
const { session } = await runtime.createSession({
  workspace: process.cwd(),
  toolInterceptor: async (ctx) => { decisions.push(ctx); return undefined; },
});
assert.equal(runtime.capabilities.toolInterception, true, "fixture can normally gate tools");

const events: RuntimeEvent[] = [];
session.subscribe((event) => events.push(event));
await session.prompt("delegate a task");
await waitFor(events, (event) => event.type === "agent_end");

const call = events.find((event) => event.type === "tool_call") as (RuntimeEvent & { detail?: { kind?: string; label?: string } }) | undefined;
assert.ok(call, "observed activity streams a live tool card");
assert.equal(call?.detail?.kind, "delegation", "Codex collaboration renders as sub-agent work");
assert.equal(call?.detail?.label, "explorer");
assert.equal(decisions.length, 0, "observed activity never asks for retroactive approval");
assert.ok(events.some((event) => event.type === "tool_result"), "observed activity completes normally");

const messages = session.getMessages() as Array<{ content?: unknown }>;
const serialized = JSON.stringify(messages);
assert.match(serialized, /tool_use/, "observed call persists in transcript history");
assert.match(serialized, /spawn_agent/, "persisted call keeps its delegation identity");
assert.match(serialized, /tool_result/, "observed result persists with the call");

session.dispose();
console.log("protocol-runtime-tool-observe: ok");
