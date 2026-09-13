// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Sub-agent nesting (src/runtime/claude-code.ts): the Claude Agent SDK stamps
// every message it generates inside a `Task` sub-agent with a message-level
// `parent_tool_use_id` (the spawning Task's tool_use id). The runtime carries
// that onto the tool_call events and the persisted assistant message so the UI
// can nest a sub-agent's own tool calls under its delegation card instead of
// rendering them flat and unlabelled among the parent's calls.
//
// These drive fake SDK turns through the real streaming loop (mirroring
// test/claude-code-tool-images.test.ts) and assert on the emitted events and the
// persisted history, plus the shared core reducer/reload path that renders them.

import assert from "node:assert/strict";
import { ClaudeCodeRuntime } from "../src/runtime/claude-code.js";
import { renderHistory } from "../packages/core/src/store-render.js";
import type { CredentialStore, ProviderCredential } from "../src/runtime/types.js";

type QueueLike = { [Symbol.asyncIterator](): AsyncIterator<any> };

class FakeQuery {
  closed = false;
  prompt?: QueueLike;
  private events: Array<{ kind: "value"; value: any } | { kind: "done" }> = [];
  private waiters: Array<{ resolve: (r: IteratorResult<any>) => void; reject: (e: unknown) => void }> = [];
  constructor(public readonly options: any) {}
  supportedModels(): Promise<any[]> { return Promise.resolve([]); }
  setModel(): void {}
  interrupt(): void {}
  close(): void {
    this.closed = true;
    const w = this.waiters.shift();
    if (w) w.resolve({ value: undefined, done: true });
    else this.events.push({ kind: "done" });
  }
  emit(msg: any): void {
    const w = this.waiters.shift();
    if (w) w.resolve({ value: msg, done: false });
    else this.events.push({ kind: "value", value: msg });
  }
  [Symbol.asyncIterator](): AsyncIterator<any> {
    const next = (): Promise<IteratorResult<any>> => {
      const ev = this.events.shift();
      if (ev) return Promise.resolve(ev.kind === "value" ? { value: ev.value, done: false } : { value: undefined, done: true });
      return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    };
    return { next };
  }
}

class FixedStore implements CredentialStore {
  async getCredential(): Promise<ProviderCredential | undefined> {
    return { provider: "anthropic", kind: "oauth", token: "tok-fixed" };
  }
}

function makeSdk() {
  const queries: FakeQuery[] = [];
  const sdk = {
    query({ prompt, options }: { prompt: QueueLike; options: any }) {
      const q = new FakeQuery(options);
      q.prompt = prompt;
      queries.push(q);
      return q;
    },
  };
  return { sdk, queries };
}

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function newSession() {
  const { sdk, queries } = makeSdk();
  const runtime = new ClaudeCodeRuntime({ credentials: new FixedStore(), sdkLoader: async () => sdk });
  const { session } = await runtime.createSession({ workspace: process.cwd() });
  const events: any[] = [];
  session.subscribe((e) => events.push(e));
  return { session, queries, events };
}

// ── A Task spawns a sub-agent whose inner tool call is stamped with the Task's
//    tool_use id; the child call inherits parentToolUseId, the parent does not ──
{
  const { session, queries, events } = await newSession();
  await session.prompt("investigate the repo");
  await waitFor(() => queries.length === 1);
  const q = queries[0]!;

  // Parent turn: the top-level agent delegates via a Task tool call.
  q.emit({ type: "assistant", message: { model: "claude-opus-4-8", content: [
    { type: "tool_use", id: "task-1", name: "Task", input: { subagent_type: "Explore", description: "map the auth flow" } },
  ] } });
  // Sub-agent turn: its own tool_use, carrying the message-level parent id.
  q.emit({ type: "assistant", parent_tool_use_id: "task-1", message: { model: "claude-opus-4-8", content: [
    { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "ls src/auth" } },
  ] } });

  await waitFor(() => events.filter((e) => e.type === "tool_call").length >= 2);

  const parentCall = events.find((e) => e.type === "tool_call" && e.toolUseId === "task-1");
  const childCall = events.find((e) => e.type === "tool_call" && e.toolUseId === "bash-1");
  assert.ok(parentCall, "the Task delegation surfaces as a tool_call");
  assert.equal(parentCall.parentToolUseId, undefined, "the top-level delegation has no parent");
  assert.equal(parentCall.detail?.kind, "delegation", "Task classifies as a delegation card");
  assert.ok(childCall, "the sub-agent's inner tool surfaces as a tool_call");
  assert.equal(childCall.parentToolUseId, "task-1", "the sub-agent tool nests under its Task delegation");

  // Persisted history retains the relationship so a reopened/forked transcript
  // reconstructs the nesting without any live agent_end.
  const messages = session.getMessages() as any[];
  const childMsg = messages.find((m) => m.parentToolUseId === "task-1");
  assert.ok(childMsg, "the sub-agent turn persists its parent id at message level");

  const transcript = renderHistory(messages);
  const child = transcript.find((e) => e.tool?.callId === "bash-1");
  const parent = transcript.find((e) => e.tool?.callId === "task-1");
  assert.equal(child?.tool?.parentToolUseId, "task-1", "reloaded child tool keeps its parent id");
  assert.equal(parent?.tool?.parentToolUseId, undefined, "reloaded delegation stays top-level");
}

console.log("ok claude-code sub-agent nesting");
