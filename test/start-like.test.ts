// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { sessionLikeFields } from "../src/session/start-like.js";

test("a session started like a worktree session gets its own worktree from the checkout", () => {
  const fields = sessionLikeFields({
    workspace: "/repos/acme/web",
    worktree: { path: "/repos/acme/web/.bivy/worktrees/bivy-session-1", branch: "bivy/session-1", repoRoot: "/repos/acme/web" },
    runtimeId: "codex",
    sandbox: "workspace-write",
    session: { getCurrentModel: () => ({ provider: "openai", id: "gpt-6" }) },
  });
  assert.deepEqual(fields, { workspace: "/repos/acme/web", agent: "codex", sandbox: "workspace-write", model: { provider: "openai", id: "gpt-6" } });
});

test("a plain-folder session is shared, and an unknown model is left to the node default", () => {
  const fields = sessionLikeFields({ workspace: "/home/me/notes", runtimeId: "claude-code", session: { getCurrentModel: () => undefined } });
  assert.deepEqual(fields, { workspace: "/home/me/notes", agent: "claude-code" });
});
