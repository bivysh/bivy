// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// ↑/↓ in the composer step through the session's sent prompts (packages/web/src/promptHistory.ts).
import assert from "node:assert/strict";
import type { TranscriptEntry } from "@bivy/core";
import { sentPrompts, stepPromptHistory } from "../packages/web/src/promptHistory.js";

const user = (id: string, text: string): TranscriptEntry => ({ id, role: "user", text });
const prompts = sentPrompts([
  user("1", "fix the build"),
  { id: "2", role: "assistant", text: "done" },
  user("3", "fix the build"),
  user("4", "look at this\n[Image attachment: shot.png]"),
  user("5", "run the tests\nthen push"),
]);
assert.deepEqual(prompts, ["fix the build", "look at this", "run the tests\nthen push"], "user prompts only, repeats once, placeholders stripped");

const step = (position: number | null, key: "ArrowUp" | "ArrowDown", text: string, caret = text.length) =>
  stepPromptHistory({ prompts, position, key, text, caret });

assert.equal(step(null, "ArrowUp", ""), 2, "empty composer: ↑ recalls the latest prompt");
assert.equal(step(2, "ArrowUp", prompts[2]!, 0), 1, "on the first line of a recalled prompt: ↑ goes one older");
assert.equal(step(2, "ArrowUp", prompts[2]!), undefined, "below the first line: ↑ moves the caret");
assert.equal(step(0, "ArrowUp", prompts[0]!), undefined, "oldest prompt: ↑ stays");
assert.equal(step(1, "ArrowDown", prompts[1]!), 2, "↓ goes one newer");
assert.equal(step(2, "ArrowDown", prompts[2]!), null, "past the newest: back to an empty composer");
assert.equal(step(1, "ArrowDown", "look at this, and more"), undefined, "an edited recall is the user's text: arrows move the caret");
assert.equal(step(null, "ArrowUp", "half typed"), undefined, "own text: arrows move the caret");
console.log("prompt-history: passed");
