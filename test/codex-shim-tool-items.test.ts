// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolRuntime } from "../src/runtime/protocol.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shim = path.join(__dirname, "..", "bin", "codex-app-server-shim.mjs");
const fakeCodex = path.join(__dirname, "fixtures", "fake-codex-collab-app-server.mjs");
chmodSync(fakeCodex, 0o755);

function waitFor(events: RuntimeEvent[], pred: (event: RuntimeEvent) => boolean, timeoutMs = 4000): Promise<RuntimeEvent> {
  const existing = events.find(pred);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const event = events.find(pred);
      if (event) { clearInterval(timer); resolve(event); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error("timed out waiting for Codex shim")); }
    }, 10);
  });
}

const runtime = new ProtocolRuntime({
  id: "codex-approvals",
  displayName: "Codex",
  command: process.execPath,
  args: [shim],
  env: { BIVY_CODEX_BIN: fakeCodex },
  capabilities: { toolInterception: true },
});
const approvals: string[] = [];
const { session } = await runtime.createSession({
  workspace: process.cwd(),
  toolInterceptor: async ({ toolName }) => { approvals.push(toolName); return undefined; },
});
const events: RuntimeEvent[] = [];
session.subscribe((event) => events.push(event));
await session.prompt("exercise Codex item events");
await waitFor(events, (event) => event.type === "agent_end");

const calls = events.filter((event) => event.type === "tool_call") as Array<RuntimeEvent & { toolName?: string; detail?: { kind?: string; label?: string } }>;
const delegation = calls.find((event) => event.toolName === "spawn_agent");
assert.equal(delegation?.detail?.kind, "delegation", "collabAgentToolCall becomes a sub-agent card");
assert.equal(delegation?.detail?.label, "gpt-5.6-sol", "sub-agent model labels the card");
const activity = calls.find((event) => event.toolName === "subagent_activity");
assert.equal(activity?.detail?.kind, "delegation", "Codex subAgentActivity becomes visible child-agent activity");
assert.equal(activity?.detail?.label, "explorer", "child agent path labels its activity card");
const activityResult = events.find((event) => event.type === "tool_result" && (event as { toolName?: string }).toolName === "subagent_activity") as (RuntimeEvent & { detail?: { result?: { text?: string } } }) | undefined;
assert.equal(activityResult?.detail?.result?.text, "interacted", "child lifecycle outcome reaches transcript detail");
const collabResultIndex = events.findIndex((event) => event.type === "tool_result" && (event as { toolName?: string }).toolName === "spawn_agent");
const agentEndIndex = events.findIndex((event) => event.type === "agent_end");
assert.ok(collabResultIndex >= 0 && collabResultIndex < agentEndIndex, "late Codex collaboration completion drains before the turn is sealed");
assert.ok(calls.some((event) => event.toolName === "shell"), "non-approved command item is still visible");
assert.deepEqual(approvals, [], "already-started app-server items never request retroactive approval");

const shellResult = events.find((event) => event.type === "tool_result" && (event as { toolName?: string }).toolName === "shell") as (RuntimeEvent & { detail?: { result?: { exitCode?: number; isError?: boolean } } }) | undefined;
assert.equal(shellResult?.detail?.result?.exitCode, 7, "Codex exit code reaches transcript detail");
assert.equal(shellResult?.detail?.result?.isError, true, "failed Codex command is visibly failed");

const history = JSON.stringify(session.getMessages());
assert.match(history, /Parent answer\./, "parent-thread prose reaches the transcript");
assert.doesNotMatch(history, /CHILD_(?:PROSE|REASONING|COMPLETION)_MUST_NOT_LEAK/, "child-thread prose never corrupts the parent answer");
assert.match(history, /spawn_agent/, "sub-agent activity persists across reopen");
assert.match(history, /commandExecution|false/, "command activity persists across reopen");

session.dispose();
console.log("codex-shim-tool-items: ok");
