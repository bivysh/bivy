// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// The composer's @ picker finds the word at the caret and inserts a path
// (packages/web/src/fileMention.ts).
import assert from "node:assert/strict";
import { fileMentionAt, insertFileMention } from "../packages/web/src/fileMention.js";

assert.deepEqual(fileMentionAt("look at @src/co", 15), { start: 8, end: 15, query: "src/co" });
assert.deepEqual(fileMentionAt("@", 1), { start: 0, end: 1, query: "" });
assert.equal(fileMentionAt("mail me at a@b.c", 16), null, "an email address is not a mention");
assert.equal(fileMentionAt("@src/co more", 4), null, "the caret has to be at the end of the word");

const mention = fileMentionAt("fix @co please", 7)!;
assert.deepEqual(insertFileMention("fix @co please", mention, { path: "src/coupon.ts", type: "file" }), { text: "fix @src/coupon.ts please", caret: 19 });
assert.deepEqual(insertFileMention("fix @sr", fileMentionAt("fix @sr", 7)!, { path: "src", type: "dir" }), { text: "fix @src/", caret: 9 }, "a folder keeps the picker open inside it");
console.log("file-mention: passed");
