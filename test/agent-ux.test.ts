// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The agent-UX eval's scoring: what counts as using Bivy the way a task needed.
import assert from "node:assert/strict";
import test from "node:test";
import { countCardBlocks, scoreAgentUx } from "../src/certification/agent-ux.js";

test("each kind of expectation passes on what the agent did and fails on what it didn't", () => {
  const seen = { blocks: { bivy_notice: 1, bivy_suggestion: 1 }, asked: false, reply: "This session runs on Build-Box.", files: ["scripts/hello.sh"] };
  const passed = (expect: Parameters<typeof scoreAgentUx>[0]) => scoreAgentUx(expect, seen, { machine: "build-box" }).map((check) => check.passed);
  assert.deepEqual(passed([{ block: "bivy_notice" }, { block: "bivy_suggestion", min: 2 }]), [true, false]);
  assert.deepEqual(passed([{ asked: true }]), [false]);
  assert.deepEqual(passed([{ reply: "{machine}" }]), [true], "placeholders fill, and case doesn't matter");
  assert.deepEqual(passed([{ file: "scripts/*.sh" }, { file: "*.sh" }]), [true, false], "a glob doesn't cross directories");
});

test("chat cards are counted wherever they sit in the history", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "Done." }, { type: "bivy_notice", notice: { id: "n", text: "x" } }] },
    { role: "assistant", content: [{ type: "bivy_suggestion" }, { type: "bivy_suggestion" }] },
  ];
  assert.deepEqual(countCardBlocks(messages), { bivy_notice: 1, bivy_suggestion: 2 });
});

