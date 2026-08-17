import assert from "node:assert/strict";
import { ClaudeCodeRuntime } from "../src/runtime/claude-code.js";

// Regression: signing in with Claude OAuth and opening the model picker before
// sending any prompt used to show an empty list. getModels() only returned the
// SDK's supportedModels(), which is populated lazily on the first prompt, so a
// fresh session reported no models. It must now fall back to the known lineup.
const runtime = new ClaudeCodeRuntime();
const { session } = await runtime.createSession({ workspace: process.cwd() });

const models = await session.getModels();
assert.ok(models.length > 0, "a fresh Claude session must list fallback models before the first prompt");
assert.ok(
  models.every((model) => model.provider === "anthropic" && model.id && model.name),
  "fallback models must be well-formed anthropic models",
);
assert.ok(
  models.some((model) => model.id === "claude-opus-4-8"),
  "fallback models must include the current Opus id",
);

console.log(`claude-code models fallback OK (${models.length} models)`);
