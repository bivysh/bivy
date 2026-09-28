// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Account-wide agent instructions (src/agent-instructions.ts): the last-writer-
// wins reconciliation that keeps every machine on the newest copy, the composed
// per-session text/file, and the profile env template that hands the file to CLI
// agents (withSessionInstructions).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentInstructionsPath,
  mergeSyncedAgentInstructions,
  readAgentInstructions,
  sessionInstructions,
  writeAgentInstructions,
  MAX_AGENT_INSTRUCTIONS_BYTES,
} from "../src/agent-instructions.js";
import { withSessionInstructions } from "../src/runtime/session-env.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-agent-instructions-"));
}

test("a newer synced copy replaces the local file and keeps the writer's timestamp", () => {
  const dir = tempDir();
  writeAgentInstructions(dir, "old", 1_000);
  assert.equal(mergeSyncedAgentInstructions(dir, { text: "new", updatedAt: 2_000 }), "imported");
  assert.deepEqual(readAgentInstructions(dir), { text: "new", updatedAt: 2_000 });
});

test("an older or missing synced copy leaves the local file and asks to republish", () => {
  const dir = tempDir();
  writeAgentInstructions(dir, "mine", 2_000);
  assert.equal(mergeSyncedAgentInstructions(dir, { text: "stale", updatedAt: 1_000 }), "local-newer");
  // An older peer re-pushed the vault without the field.
  assert.equal(mergeSyncedAgentInstructions(dir, undefined), "local-newer");
  assert.deepEqual(readAgentInstructions(dir), { text: "mine", updatedAt: 2_000 });
  // A machine that never had any has nothing to publish.
  assert.equal(mergeSyncedAgentInstructions(tempDir(), undefined), "unchanged");
});

test("clearing propagates: a newer empty copy clears the instructions sessions receive", () => {
  const dir = tempDir();
  writeAgentInstructions(dir, "Use pnpm.", 1_000);
  const before = sessionInstructions(dir);
  assert.ok(before);
  assert.match(before.text, /repository's instructions win/);
  assert.match(before.text, /Use pnpm\./);
  assert.equal(fs.readFileSync(before.file, "utf8"), before.text);

  assert.equal(mergeSyncedAgentInstructions(dir, { text: "", updatedAt: 2_000 }), "imported");
  assert.equal(sessionInstructions(dir), undefined);
  // The composed file an injected MCP server may still point at is gone too.
  assert.equal(fs.existsSync(before.file), false);
  assert.equal(fs.existsSync(agentInstructionsPath(dir)), true, "the empty file keeps the clear's timestamp");
});

test("instructions over the size limit are rejected", () => {
  assert.throws(() => writeAgentInstructions(tempDir(), "x".repeat(MAX_AGENT_INSTRUCTIONS_BYTES + 1)), /limited to/);
});

test("a profile's env template receives the composed file, without clobbering an operator's variable", () => {
  const instructions = { text: "t", file: "/data/a \"b\".md" };
  const options = { env: { KEEP: "1" }, instructionsEnv: { OPENCODE_CONFIG_CONTENT: '{"instructions":["{fileJson}"]}', RAW: "{file}" } };
  const applied = withSessionInstructions(options, instructions);
  assert.deepEqual(JSON.parse(applied.env.OPENCODE_CONFIG_CONTENT!), { instructions: [instructions.file] });
  assert.equal(applied.env.RAW, instructions.file);
  assert.equal(applied.env.KEEP, "1");

  const operatorSet = withSessionInstructions({ ...options, env: { OPENCODE_CONFIG_CONTENT: "{}" } }, instructions);
  assert.equal(operatorSet.env.OPENCODE_CONFIG_CONTENT, "{}");
  assert.equal(withSessionInstructions(options, undefined), options);
});
