// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolRuntime } from "../src/runtime/protocol.js";
import type { RuntimeEvent } from "../src/runtime/types.js";

// What Codex asks mid-turn reaches Bivy's governance and the answers go back in
// Codex's own shapes; the effort picker and steering drive the app-server.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shim = path.join(__dirname, "..", "bin", "codex-app-server-shim.mjs");
const fakeCodex = path.join(__dirname, "fixtures", "fake-codex-requests-app-server.mjs");
chmodSync(fakeCodex, 0o755);
const logFile = path.join(mkdtempSync(path.join(tmpdir(), "bivy-codex-requests-")), "log.jsonl");

async function until<T>(read: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const received = () => readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const answerTo = (id: number) => received().find((m) => m.id === id && m.method === undefined)?.result;

const runtime = new ProtocolRuntime({
  id: "codex-approvals",
  displayName: "Codex",
  command: process.execPath,
  args: [shim],
  env: { BIVY_CODEX_BIN: fakeCodex, FAKE_CODEX_LOG: logFile },
  capabilities: { toolInterception: true },
});
const asked: Array<{ toolName: string; input: any }> = [];
const { session } = await runtime.createSession({
  workspace: process.cwd(),
  toolInterceptor: async ({ toolName, input }) => {
    asked.push({ toolName, input });
    if (toolName === "AskUserQuestion") return { handled: true, result: "The user answered: B", answers: { "Which one?": "B" } };
    if (toolName === "request_permissions") return { block: true, reason: "User rejected request_permissions" };
    if (toolName === "McpElicitation") return { handled: true, result: "sent", elicitation: { action: "accept", content: { name: "Ada" } } };
    return undefined;
  },
});
const events: RuntimeEvent[] = [];
session.subscribe((event) => events.push(event));

await session.prompt("ask me things");
await until(() => events.find((e) => e.type === "agent_end"), "the first turn");

assert.deepEqual(asked.map((a) => a.toolName), ["AskUserQuestion", "request_permissions", "lookup", "McpElicitation"], "questions, sandbox widening, MCP approvals and MCP forms all reach the guardian");
assert.deepEqual(asked[0].input.questions, [{ question: "Which one?", header: "Pick", options: [{ label: "A", description: "first" }, { label: "B", description: "second" }] }], "the card gets the question but never a secret one");
assert.deepEqual(answerTo(1000), { answers: { "q-pick": { answers: ["B"] } } }, "answers go back keyed by Codex's question id");
assert.deepEqual(answerTo(1001), { permissions: {}, scope: "turn" }, "a denied permission request grants nothing");
assert.deepEqual(answerTo(1002), { action: "accept", content: null, _meta: null }, "an allowed MCP tool approval is accepted");
assert.deepEqual(asked[3].input, { serverName: "docs", message: "Your name?", mode: "form", requestedSchema: { type: "object", properties: { name: { type: "string" } } } }, "the MCP form reaches the guardian as asked");
assert.deepEqual(answerTo(1003), { action: "accept", content: { name: "Ada" }, _meta: null }, "the form's answer goes back to the server");
assert.equal(session.getAvailableThinkingLevels?.().join(","), "low,high", "the default model's efforts reach the picker");
assert.equal(session.getThinkingLevel?.(), "low", "starting at the model's default effort");

// Effort: applied to the thread and carried on later turns.
session.setThinkingLevel?.("high");
await until(() => received().find((m) => m.method === "thread/settings/update" && m.params.effort === "high"), "the effort update");
const ends = () => events.filter((e) => e.type === "agent_end").length;
await session.prompt("second turn");
const secondTurn = await until(() => received().filter((m) => m.method === "turn/start")[1], "the second turn");
assert.equal(secondTurn.params.effort, "high", "the picked effort rides on turn/start");

// Steering: a message mid-turn joins the running turn instead of starting one.
await until(() => (session.isStreaming ? true : undefined), "the second turn to stream");
await session.prompt("one more thing", { streamingBehavior: "steer" });
const steer = await until(() => received().find((m) => m.method === "turn/steer"), "turn/steer");
assert.equal(steer.params.expectedTurnId, "turn-2", "the steer names the running turn");
await until(() => (ends() >= 2 ? true : undefined), "the steered turn to end");
assert.equal(received().filter((m) => m.method === "turn/start").length, 2, "no extra turn was started");

session.dispose();
