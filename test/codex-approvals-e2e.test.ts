import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ProtocolRuntime } from "../src/runtime/protocol.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

// Live end-to-end for the Codex app-server shim: governed session + resume,
// driven through ProtocolRuntime exactly as the daemon does. It makes real model
// calls, so it SELF-SKIPS unless Codex is installed AND opted in via
// BIVY_CODEX_E2E=1 — CI stays green with no Codex/credentials.
//
//   BIVY_CODEX_E2E=1 npx tsx test/codex-approvals-e2e.test.ts
//
// Pinned as a runnable regression: proves thread/resume reconnects a prior
// thread (by its rollout id) and keeps context — the basis for governed +
// resumable Codex.

function codexAvailable(): boolean {
  return spawnSync("command", ["-v", "codex"], { shell: true, stdio: "ignore" }).status === 0;
}

if (process.env.BIVY_CODEX_E2E !== "1" || !codexAvailable()) {
  console.log("codex-approvals-e2e: skipped (set BIVY_CODEX_E2E=1 with Codex installed to run)");
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shim = path.join(__dirname, "..", "bin", "codex-app-server-shim.mjs");

function waitFor(events: RuntimeEvent[], pred: (event: RuntimeEvent) => boolean, timeoutMs = 90_000): Promise<RuntimeEvent> {
  const existing = events.find(pred);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const event = events.find(pred);
      if (event) { clearInterval(timer); resolve(event); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error("timed out waiting for codex event")); }
    }, 25);
  });
}

// A resumable ProtocolRuntime over the real shim (mirrors codexAppServerRuntime).
const runtime = new ProtocolRuntime({
  id: "codex-approvals",
  displayName: "Codex",
  command: process.execPath,
  args: [shim],
  capabilities: { toolInterception: true },
  resumable: true,
});
assert.equal(runtime.capabilities.resume, true, "resumable runtime advertises resume");

// Auto-allow approvals so the turn can complete unattended.
const approvals: string[] = [];
const { session } = await runtime.createSession({
  workspace: process.cwd(),
  toolInterceptor: async (ctx) => { approvals.push(ctx.toolName); return undefined; },
});

const events: RuntimeEvent[] = [];
session.subscribe((event) => events.push(event));
await session.prompt("Reply with exactly the word BANANA and nothing else. Do not run any tools.");
await waitFor(events, (event) => event.type === "agent_end");

const reply1 = session.getMessages().map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
assert.match(reply1, /BANANA/i, "first governed turn produced the expected reply");

// The resume token round-trips as the Codex thread id (== rollout/session id).
const threadId = session.sessionFile;
assert.ok(threadId && /[0-9a-f-]{16,}/i.test(threadId), `got a thread/rollout id to resume (${threadId})`);
session.dispose();

// Resume in a FRESH shim process by that id and confirm prior context survives.
const { session: resumed } = await runtime.openSession({
  workspace: process.cwd(),
  sessionFile: threadId!,
  toolInterceptor: async () => undefined,
});
assert.equal(resumed.sessionFile, threadId, "resumed session round-trips the same id");

const resumedEvents: RuntimeEvent[] = [];
resumed.subscribe((event) => resumedEvents.push(event));
await resumed.prompt("Earlier in this same conversation I asked you to reply with a specific fruit word. What was that word? Reply with only that word.");
await waitFor(resumedEvents, (event) => event.type === "agent_end");

const reply2 = resumed.getMessages().map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
assert.match(reply2, /BANANA/i, "resumed thread remembered context from before the reconnect");
resumed.dispose();

console.log("codex-approvals-e2e: all tests passed (governed session + resume with context)");
process.exit(0);
