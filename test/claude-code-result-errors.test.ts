// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad

import assert from "node:assert/strict";
import { ClaudeCodeRuntime } from "../src/runtime/claude-code.js";

// A failed Claude Code turn ends with an error `result` whose message rides
// `errors` (the error variant has no `result` text): a startup failure such as
// a missing sandbox, max turns, a crash. The runtime carries that message on
// agent_end, as every runtime does, so the daemon marks the turn failed and
// `bivy exec` exits non-zero. A turn the user stopped also ends with an error
// result; that one is the interrupt, not a failure.
//
// An API failure can also arrive as a synthetic assistant message (a usage
// limit, a refused sign-in) followed by a *successful* result. That turn failed
// too, so agent_end carries the message and, for a limit, the quota's reset.

type QueueLike = { [Symbol.asyncIterator](): AsyncIterator<any> };

class FakeQuery {
  private events: any[] = [];
  private waiters: Array<(r: IteratorResult<any>) => void> = [];
  constructor(public readonly options: any) {}
  supportedModels(): Promise<any[]> { return Promise.resolve([]); }
  setModel(): void {}
  interrupt(): void {}
  private rejecters: Array<(e: unknown) => void> = [];
  close(): void { this.waiters.shift()?.({ value: undefined, done: true }); }
  fail(error: unknown): void { this.waiters.shift(); this.rejecters.shift()?.(error); }
  emit(msg: any): void {
    this.rejecters.shift();
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.events.push(msg);
  }
  [Symbol.asyncIterator](): AsyncIterator<any> {
    return {
      next: () => this.events.length
        ? Promise.resolve({ value: this.events.shift(), done: false })
        : new Promise((resolve, reject) => { this.waiters.push(resolve); this.rejecters.push(reject); }),
    };
  }
}

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function start() {
  const queries: FakeQuery[] = [];
  const sdk = { query({ options }: { prompt: QueueLike; options: any }) { const q = new FakeQuery(options); queries.push(q); return q; } };
  const runtime = new ClaudeCodeRuntime({ env: { ANTHROPIC_API_KEY: "sk-test" }, sdkLoader: async () => sdk });
  const { session } = await runtime.createSession({ workspace: process.cwd() });
  const events: any[] = [];
  session.subscribe((e) => events.push(e));
  await session.prompt("go");
  await waitFor(() => queries.length === 1);
  return { session, query: queries[0], events };
}

const startupFailure = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  errors: ["A sandbox is required but bubblewrap is not installed."],
  startup_failure_reason: "sandbox_required_unavailable",
};

{
  const { query, events } = await start();
  assert.equal(query.options.env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS, "1", "stderr-only startup failures also come back as a result");
  query.emit(startupFailure);
  await waitFor(() => events.some((e) => e.type === "agent_end"));
  // The SDK then throws the same failure; it must not be reported twice.
  query.fail(new Error(`Claude Code returned an error result: ${startupFailure.errors[0]}`));
  await new Promise((r) => setTimeout(r, 20));
  const ends = events.filter((e) => e.type === "agent_end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].error, startupFailure.errors[0], "agent_end carries the failure's own message");
  assert.deepEqual(events.filter((e) => e.type === "session.error").map((e) => e.error), [startupFailure.errors[0]]);
}

{
  const { session, query, events } = await start();
  await session.abort();
  query.emit({ ...startupFailure, errors: ["Request was aborted."] });
  await waitFor(() => events.some((e) => e.type === "agent_end"));
  assert.equal(events.find((e) => e.type === "agent_end").error, undefined, "a stopped turn is not a failure");
  assert.ok(!events.some((e) => e.type === "session.error"));
}

// The SDK's shape for a rejected plan window: a synthetic message flagged as an
// API error, carrying the quota's reset (epoch seconds), then a clean result.
const limitMessage = {
  type: "assistant",
  error: "rate_limit",
  is_api_error_message: true,
  quotaLimits: { status: "rejected", resetsAt: 1793606400, rateLimitType: "five_hour" },
  message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit · resets 6:30pm (UTC)" }] },
};
const cleanResult = { type: "result", subtype: "success", result: "", terminal_reason: "api_error" };

{
  const { query, events } = await start();
  query.emit(limitMessage);
  query.emit(cleanResult);
  await waitFor(() => events.some((e) => e.type === "agent_end"));
  const end = events.find((e) => e.type === "agent_end");
  assert.equal(end.error, "You've hit your session limit · resets 6:30pm (UTC)", "the limit is the turn's failure");
  assert.equal(end.resetsAt, new Date(1793606400 * 1000).toISOString(), "the reset comes from the quota, not the text");
  assert.ok(!events.some((e) => e.type === "session.error"), "the message is already in the chat; no toast");
}

{
  // The SDK retried past a 500 and the model answered: not a failure.
  const { query, events } = await start();
  query.emit({ type: "assistant", error: "server_error", message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 500" }] } });
  query.emit({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "hi" }] } });
  query.emit(cleanResult);
  await waitFor(() => events.some((e) => e.type === "agent_end"));
  assert.equal(events.find((e) => e.type === "agent_end").error, undefined);
}
