// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import { toModelInfo } from "../src/runtime/normalize.js";

test("pi-shaped record maps every field through unchanged", () => {
  const info = toModelInfo(
    { provider: "openai", id: "gpt-x", name: "GPT X", reasoning: true, contextWindow: 200000, maxTokens: 8000, input: { foo: 1 } },
    { configured: true },
  );
  assert.deepEqual(info, {
    provider: "openai",
    id: "gpt-x",
    name: "GPT X",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 8000,
    input: { foo: 1 },
    configured: true,
  });
});

test("claude-shaped record: default provider, supportsThinking, maxOutputTokens, displayName", () => {
  const info = toModelInfo(
    { id: "claude-opus", displayName: "Claude Opus", supportsThinking: true, maxOutputTokens: 64000, contextWindow: 200000 },
    { defaultProvider: "anthropic" },
  );
  assert.equal(info.provider, "anthropic");
  assert.equal(info.id, "claude-opus");
  assert.equal(info.name, "Claude Opus");
  assert.equal(info.reasoning, true);
  assert.equal(info.maxTokens, 64000);
  assert.equal(info.contextWindow, 200000);
  // input/configured absent when not supplied
  assert.equal("input" in info, false);
  assert.equal("configured" in info, false);
});

test("id fallback chain: id → model → String(model)", () => {
  assert.equal(toModelInfo({ id: "a" }).id, "a");
  assert.equal(toModelInfo({ model: "b" }).id, "b");
  assert.equal(toModelInfo("c").id, "c");
});

test("name falls back to id; provider falls back to empty string", () => {
  const info = toModelInfo({ id: "bare" });
  assert.equal(info.name, "bare");
  assert.equal(info.provider, "");
  assert.equal(info.reasoning, false);
});

test("configured:false is preserved (not dropped as falsy)", () => {
  const info = toModelInfo({ id: "x", provider: "p" }, { configured: false });
  assert.equal(info.configured, false);
});
