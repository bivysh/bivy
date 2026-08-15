#!/usr/bin/env node
// Minimal Codex app-server used to certify Bivy's item translation without
// credentials or a real model call.
import readline from "node:readline";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "model/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { data: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", isDefault: true }], nextCursor: null } });
    return;
  }
  if (message.method === "thread/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-fixture" } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-fixture" } } });
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread-fixture" } });
    // Child and parent message streams share one app-server connection. The shim
    // must not splice this child prose/reasoning into the parent's answer.
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "child-thread", turnId: "child-turn", itemId: "child-message", delta: "CHILD_PROSE_MUST_NOT_LEAK" } });
    send({ jsonrpc: "2.0", method: "item/reasoning/textDelta", params: { threadId: "child-thread", turnId: "child-turn", itemId: "child-reasoning", delta: "CHILD_REASONING_MUST_NOT_LEAK" } });
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-fixture", turnId: "turn-fixture", itemId: "parent-message", delta: "Parent answer." } });
    const collab = {
      type: "collabAgentToolCall", id: "collab-1", tool: "spawnAgent", status: "inProgress",
      senderThreadId: "thread-fixture", receiverThreadIds: ["child-thread"], agentsStates: {},
      model: "gpt-5.6-sol", prompt: "Inspect the workspace",
    };
    send({ jsonrpc: "2.0", method: "item/started", params: { item: collab } });
    const activity = {
      type: "subAgentActivity", id: "activity-1", kind: "interacted",
      agentThreadId: "child-thread", agentPath: "explorer",
    };
    send({ jsonrpc: "2.0", method: "item/started", params: { item: activity } });
    send({ jsonrpc: "2.0", method: "item/completed", params: { item: activity } });
    const shell = {
      type: "commandExecution", id: "shell-1", command: "false", commandActions: [], cwd: "/tmp",
      status: "failed", aggregatedOutput: "command failed", exitCode: 7,
    };
    send({ jsonrpc: "2.0", method: "item/started", params: { item: shell } });
    send({ jsonrpc: "2.0", method: "item/completed", params: { item: shell } });
    send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "child-thread", item: { type: "agentMessage", id: "child-complete-only", text: "CHILD_COMPLETION_MUST_NOT_LEAK" } } });
    send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-fixture", item: { type: "agentMessage", id: "parent-message", text: "Parent answer." } } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed" } } });
    // Codex 0.147 may deliver this final collaboration completion just after the
    // turn boundary. The shim must drain it before publishing session.done.
    setTimeout(() => send({ jsonrpc: "2.0", method: "item/completed", params: { item: { ...collab, status: "completed" } } }), 20);
  }
});
