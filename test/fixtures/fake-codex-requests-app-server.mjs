#!/usr/bin/env node
// Codex app-server stand-in that asks the client things mid-turn: a
// request_user_input question, a sandbox permission request, an MCP tool
// approval, an MCP form and a managed human-only command checkpoint. Every client message it receives is appended to
// $FAKE_CODEX_LOG as one JSON line, so a test can check what the shim answered.
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const log = (value) => appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(value)}\n`);
const thread = "thread-requests";
let turns = 0;

// Each server request, sent once the previous one is answered.
const requests = [
  { method: "item/tool/requestUserInput", params: { threadId: thread, turnId: "turn-1", itemId: "ask-1", isBlocking: true, autoResolutionMs: null, questions: [
    { id: "q-pick", header: "Pick", question: "Which one?", isOther: true, isSecret: false, options: [{ label: "A", description: "first" }, { label: "B", description: "second" }] },
    { id: "q-secret", header: "Key", question: "Your API key?", isOther: false, isSecret: true, options: null },
  ] } },
  { method: "item/permissions/requestApproval", params: { threadId: thread, turnId: "turn-1", itemId: "perm-1", environmentId: null, startedAtMs: 0, cwd: "/tmp", reason: "needs the network", permissions: { network: { enabled: true }, fileSystem: null } } },
  // Codex starts the MCP item, then asks to approve it.
  { before: [{ method: "item/started", params: { threadId: thread, turnId: "turn-1", item: { type: "mcpToolCall", id: "mcp-1", server: "docs", tool: "lookup", arguments: { q: "x" }, status: "inProgress" } } }],
    method: "mcpServer/elicitation/request", params: { threadId: thread, turnId: "turn-1", serverName: "docs", mode: "form", message: "Allow lookup?", requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "lookup", tool_params: { q: "x" } } } },
  { before: [{ method: "item/completed", params: { threadId: thread, turnId: "turn-1", item: { type: "mcpToolCall", id: "mcp-1", server: "docs", tool: "lookup", arguments: { q: "x" }, status: "completed", result: { content: [{ type: "text", text: "found" }] } } } }],
    method: "mcpServer/elicitation/request", params: { threadId: thread, turnId: "turn-1", serverName: "docs", mode: "form", message: "Your name?", requestedSchema: { type: "object", properties: { name: { type: "string" } } }, _meta: null } },
  { method: "item/commandExecution/requestApproval", params: { threadId: thread, turnId: "turn-1", itemId: "call-1", approvalId: "ap-1", kind: "humanCommand", command: "git push", cwd: "/tmp", startedAtMs: 0 } },
];
let next = 0;
function ask() {
  const { before = [], ...request } = requests[next] ?? {};
  if (!request.method) return finish();
  for (const notification of before) send({ jsonrpc: "2.0", ...notification });
  send({ jsonrpc: "2.0", id: 1000 + next, ...request });
}
function finish() {
  send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: thread, turnId: `turn-${turns}`, itemId: `msg-${turns}`, delta: "Done." } });
  send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: thread, turn: { id: `turn-${turns}`, status: "completed" } } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  log(message);
  // A client response to one of our requests.
  if (message.method === undefined && message.id >= 1000) { next += 1; ask(); return; }
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize": return reply({});
    case "model/list": return reply({ nextCursor: null, data: [
      { id: "m-effort", displayName: "Effort model", isDefault: true, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "high", description: "" }], defaultReasoningEffort: "low" },
      { id: "m-plain", displayName: "Plain model", hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: "medium" },
    ] });
    case "thread/start": return reply({ thread: { id: thread } });
    // Answered late, like a busy app-server: a message sent right after a pick
    // must not wait on this reply to carry the new settings.
    case "thread/settings/update": { setTimeout(() => reply({}), 300); return; }
    case "turn/steer": reply({ turnId: message.params.expectedTurnId }); return finish();
    case "turn/start": {
      turns += 1;
      const id = `turn-${turns}`;
      const start = () => {
        reply({ turn: { id } });
        send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: thread, turn: { id } } });
      };
      // The first turn asks its questions; later ones stay open until a
      // steering message joins them, so a slow runner can't end one first.
      if (turns === 1) { start(); ask(); return; }
      // Later turns start late, so a steer arrives before the turn has an id.
      setTimeout(start, 100);
      return;
    }
    default: return reply({});
  }
});
