import assert from "node:assert/strict";
import { claudeCommandsFromInit } from "../src/runtime/claude-code.js";

// The SDK's system/init reports slash_commands + skills as bare names (no
// leading slash). claudeCommandsFromInit normalizes to "/name", drops blanks,
// and dedupes (slash_commands win over a same-named skill).
const init = {
  type: "system",
  subtype: "init",
  slash_commands: ["compact", "/clear", "review", "", "compact"],
  skills: ["deep-research", "review"], // "review" dup with a slash_command
};

assert.deepEqual(claudeCommandsFromInit(init), [
  { name: "/compact" },
  { name: "/clear" },
  { name: "/review" },
  { name: "/deep-research" },
]);

// Missing / malformed fields degrade to [] rather than throwing.
assert.deepEqual(claudeCommandsFromInit({}), []);
assert.deepEqual(claudeCommandsFromInit({ slash_commands: "not-an-array" }), []);
assert.deepEqual(claudeCommandsFromInit(undefined), []);

console.log("claude-commands: all tests passed");
