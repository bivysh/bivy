// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import test from "node:test";
import { SessionStore } from "../packages/core/src/store.js";

// A failed turn can leave a tool the log never saw finish (the agent's stderr
// stream). Reopened, it must not spin "Working" on a session that is idle.
const messages = [
  { role: "user", content: "hi" },
  { role: "assistant", bivyKind: "tool", afterMessageCount: 1, createdAt: 1, id: "bivy-tool-call-agent-output", content: [{ type: "tool_use", id: "agent-output", name: "agent_output", input: { stream: "stderr", output: "boom" } }] },
];
const toolStatus = (store: SessionStore) => store.getState().activeSession.transcript.find((entry) => entry.tool)?.tool?.status;

test("history closes unfinished tools once the session has settled, not while it works", () => {
  const idle = new SessionStore();
  idle.beginOpen("s");
  idle.apply({ type: "session.history", sessionId: "s", isStreaming: false, messages });
  assert.equal(toolStatus(idle), "done");
  const working = new SessionStore();
  working.beginOpen("s");
  working.apply({ type: "session.history", sessionId: "s", isStreaming: true, messages });
  assert.equal(toolStatus(working), "running");
});

// The node's session-less history names its default agent. On a draft whose
// agent was just chosen (Connect your AI picks Codex for a ChatGPT plan), it
// must not pin the composer and its model list back to that default.
test("a session-less history keeps the draft's chosen agent", () => {
  const store = new SessionStore();
  store.apply({ type: "runtimes.list", runtimes: [{ id: "pi", name: "Pi" }, { id: "codex", name: "Codex" }], current: { id: "pi", name: "Pi" } });
  store.setSelectedAgentLocal("codex");
  store.apply({ type: "session.history", runtimeId: "pi", agentName: "Pi", messages: [] });
  assert.equal(store.getState().activeSession.activeRuntimeId, null);
  assert.equal(store.getState().catalogs.selectedAgentId, "codex");
});
