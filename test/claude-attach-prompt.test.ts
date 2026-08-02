// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Discoverability: `bivy attach` is just a shell command, so without a system-
// prompt hint the Claude agent has no way to know it can send a file to the user
// and answers "I have no way to do that". These lock in that every Claude query
// (a) appends the attach instructions to the claude_code preset, and (b) carries
// BIVY_SESSION_ID in the subprocess env so the bare command resolves the session.

import assert from "node:assert/strict";
import { ClaudeCodeRuntime, BIVY_ATTACH_SYSTEM_PROMPT } from "../src/runtime/claude-code.js";

// prompt() runs an Anthropic credential preflight and refuses to spawn the query
// (so no options to inspect) when none is present. A CI runner has no credential;
// give it a dummy so the first turn actually spawns. `||=` keeps a real one.
process.env.ANTHROPIC_API_KEY ||= "test-key-for-preflight";

function makeSdk() {
  const queries: any[] = [];
  const sdk = {
    query({ options }: { prompt: unknown; options: any }) {
      const q = {
        options,
        closed: false,
        close() { this.closed = true; },
        supportedModels: async () => [],
        setModel() {},
        interrupt() {},
        [Symbol.asyncIterator]() {
          let done = false;
          return { next: async () => (done ? { value: undefined, done: true } : ((done = true), { value: undefined, done: true })) };
        },
      };
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

const { sdk, queries } = makeSdk();
const runtime = new ClaudeCodeRuntime({ sdkLoader: async () => sdk });
const { session } = await runtime.createSession({ workspace: process.cwd() });
await session.prompt("send me the readme");
await waitFor(() => queries.length === 1);

const opts = queries[0].options;
assert.deepEqual(
  opts.systemPrompt,
  { type: "preset", preset: "claude_code", append: BIVY_ATTACH_SYSTEM_PROMPT },
  "the claude_code preset must be kept, with the attach instructions appended",
);
assert.match(BIVY_ATTACH_SYSTEM_PROMPT, /bivy attach/, "the hint must name the command the agent should run");
assert.equal(opts.env.BIVY_SESSION_ID, session.id, "the session id must be in the subprocess env so `bivy attach` resolves it");

console.log("claude attach discoverability OK");
