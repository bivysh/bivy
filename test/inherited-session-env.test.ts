// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import test from "node:test";
import { scrubInheritedSessionEnv } from "../src/runtime/inherited-session-env.js";

test("a node started from an agent's shell drops that session's markers and keeps the user's config", () => {
  const env: NodeJS.ProcessEnv = {
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDECODE: "1",
    CODEX_THREAD_ID: "t",
    BIVY_SESSION_ID: "s",
    BIVY_SESSION_TOKEN: "bst_x",
    CLAUDE_CONFIG_DIR: "/home/u/.claude",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    PATH: "/usr/bin",
  };
  scrubInheritedSessionEnv(env);
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR: "/home/u/.claude", CLAUDE_CODE_OAUTH_TOKEN: "oauth", PATH: "/usr/bin" });
});
