// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Plan/usage limits that the SDK reports as a MESSAGE, not a thrown error
// (src/agents/claude-code/runtime.ts). Claude Code answers a rejected 429 with a
// synthetic assistant message — "You've hit your session limit · resets 6:30pm
// (UTC)", flagged isApiErrorMessage and carrying the quota's own resetsAt — and
// then ends the turn with an ordinary successful `result`. A turn that looks
// finished never reaches the daemon's recovery path, so the session showed a
// dead end instead of the ways past the limit (fork / retry when it resets).
// The runtime therefore carries the failure out on agent_end.

import assert from "node:assert/strict";
import { ClaudeCodeRuntime } from "../src/runtime/claude-code.js";
import { detectSessionLimit, sessionLimitNotice } from "../src/policy/session-limit.js";
import type { CredentialStore, ProviderCredential } from "../src/runtime/types.js";

type QueueLike = { [Symbol.asyncIterator](): AsyncIterator<any> };

class FakeQuery {
  prompt?: QueueLike;
  private events: Array<{ kind: "value"; value: any } | { kind: "done" }> = [];
  private waiters: Array<{ resolve: (r: IteratorResult<any>) => void; reject: (e: unknown) => void }> = [];
  constructor(public readonly options: any) {}
  supportedModels(): Promise<any[]> { return Promise.resolve([]); }
  setModel(): void {}
  interrupt(): void {}
  close(): void {
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

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function newSession() {
  const queries: FakeQuery[] = [];
  const sdk = {
    query({ prompt, options }: { prompt: QueueLike; options: any }) {
      const q = new FakeQuery(options);
      q.prompt = prompt;
      queries.push(q);
      return q;
    },
  };
  const runtime = new ClaudeCodeRuntime({ credentials: new FixedStore(), sdkLoader: async () => sdk });
  const { session } = await runtime.createSession({ workspace: process.cwd() });
  const events: any[] = [];
  session.subscribe((e) => events.push(e));
  return { session, queries, events };
}

const LIMIT_TEXT = "You've hit your session limit · resets 6:30pm (UTC)";
// The quota block states the reset as a Unix epoch in SECONDS.
const RESETS_AT_EPOCH = 1793039400;
const RESETS_AT_ISO = new Date(RESETS_AT_EPOCH * 1000).toISOString();

function limitMessage() {
  return {
    type: "assistant",
    error: "rate_limit",
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    quotaLimits: { status: "rejected", resetsAt: RESETS_AT_EPOCH, rateLimitType: "five_hour" },
    message: { model: "<synthetic>", content: [{ type: "text", text: LIMIT_TEXT }] },
  };
}

// ── A rejected usage limit ends the turn as a failure, with the quota's reset ──
{
  const { session, queries, events } = await newSession();
  await session.prompt("keep going");
  await waitFor(() => queries.length === 1);
  const q = queries[0]!;

  q.emit(limitMessage());
  q.emit({ type: "result", subtype: "success", result: "" });
  await waitFor(() => events.some((e) => e.type === "agent_end"));

  const end = events.find((e) => e.type === "agent_end");
  assert.equal(end.error, LIMIT_TEXT, "the turn ends carrying the limit as its error");
  assert.equal(end.resetsAt, RESETS_AT_ISO, "the quota's own reset instant rides along");

  // The daemon's recovery path turns exactly that into the offer the user sees.
  const limit = detectSessionLimit(end.error, { resetsAtHint: end.resetsAt });
  assert.ok(limit, "the carried error classifies as a limit");
  assert.deepEqual(sessionLimitNotice("Claude Code", limit!).actions, ["fork", `retry-at-reset:${RESETS_AT_ISO}`]);
}

// ── An API error the SDK retried past is not a failure: a real reply clears it ──
{
  const { session, queries, events } = await newSession();
  await session.prompt("keep going");
  await waitFor(() => queries.length === 1);
  const q = queries[0]!;

  q.emit({ type: "assistant", isApiErrorMessage: true, message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 500 upstream" }] } });
  q.emit({ type: "assistant", message: { model: "claude-opus-4-8", content: [{ type: "text", text: "Done." }] } });
  q.emit({ type: "result", subtype: "success", result: "Done." });
  await waitFor(() => events.some((e) => e.type === "agent_end"));

  const end = events.find((e) => e.type === "agent_end");
  assert.equal(end.error, undefined, "a recovered turn reports no error");
}

console.log("ok claude-code usage limit");
