// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// A very long text paste attaches as a file (packages/web/src/longPaste.ts).
import assert from "node:assert/strict";
import { LONG_PASTE_CHARS, longPasteName } from "../packages/web/src/longPaste.js";

const long = "x".repeat(LONG_PASTE_CHARS);
assert.equal(longPasteName(long.slice(1), []), null, "a normal paste stays text");
assert.equal(longPasteName(long, ["notes.md"]), "pasted-text.md");
assert.equal(longPasteName(long, ["pasted-text.md", "pasted-text-2.md"]), "pasted-text-3.md", "a second long paste doesn't replace the first");
console.log("long-paste: passed");
