// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// "↑ Prompt" steps back through the prompts above the view (packages/web/src/chatScroll.ts).
import assert from "node:assert/strict";
import { previousPromptTop } from "../packages/web/src/chatScroll.js";

const prompts = [0, 800, 2000];
assert.equal(previousPromptTop(prompts, 2500), 1988, "the prompt being answered, just below the edge");
assert.equal(previousPromptTop(prompts, 1988), 788, "landed on one: the next tap goes to the one before");
assert.equal(previousPromptTop(prompts, 300), 0, "the first prompt or nothing above: the top of what is loaded");
console.log("chat-jump: passed");
