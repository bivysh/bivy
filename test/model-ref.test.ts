// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import { resolveModelRef } from "../src/runtime/model-ref.js";

const models = [
  { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
  { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { provider: "opencode", id: "opencode/big-pickle", name: "Big Pickle" },
];

test("a provider-less model id binds to a catalog entry for any runtime's id shape", () => {
  const bind = (id: string, current?: string) => resolveModelRef(models, { provider: "", id }, current ? { provider: current } : undefined);
  assert.deepEqual(bind("gpt-5.6-sol"), { provider: "openai-codex", id: "gpt-5.6-sol" });
  assert.deepEqual(bind("gpt-5.6-sol", "openai"), { provider: "openai", id: "gpt-5.6-sol" }, "ties prefer the current provider");
  assert.deepEqual(bind("openai/gpt-5.6-sol"), { provider: "openai", id: "gpt-5.6-sol" }, "provider/id shorthand");
  assert.deepEqual(bind("big-pickle"), { provider: "opencode", id: "opencode/big-pickle" }, "bare name of an ACP slash id");
  assert.deepEqual(bind("opencode/big-pickle"), { provider: "opencode", id: "opencode/big-pickle" }, "full ACP id");
  const opencode = [{ provider: "openai", id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol" }, { provider: "opencode", id: "opencode/gpt-5.6-sol", name: "GPT-5.6 Sol" }];
  assert.deepEqual(resolveModelRef(opencode, { provider: "", id: "openai-codex/gpt-5.6-sol" }, { provider: "opencode" }), { provider: "openai", id: "openai/gpt-5.6-sol" }, "a ChatGPT-plan model binds to the agent's own name for that provider");
  assert.deepEqual(bind("unknown"), { provider: "", id: "unknown" }, "unknown ids pass through for the runtime to reject");
  assert.deepEqual(resolveModelRef(models, { provider: "anthropic", id: "x" }), { provider: "anthropic", id: "x" }, "explicit provider wins");
});
