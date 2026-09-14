// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// RuntimeHost.resolveRuntimeId must accept the SAME friendly names the picker
// and `bivy run` use — the aliases integrations already declare as data — not
// only exact canonical ids. Regression guard for the bug where
// `bivy exec --agent claude` failed with "Unknown agent: claude" because the
// session/exec path did an exact `.id` match and ignored the registry aliases.
import { strict as assert } from "node:assert";
import test from "node:test";

import { RuntimeHost } from "../src/runtime/host.js";

function makeHost() {
  return new RuntimeHost({ credsDir: "/tmp/bivy-test-pi", piDir: "/tmp/bivy-test-pi", sessionsDir: "/tmp/bivy-test-pi/sessions" });
}

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  // Pin the operator commands so resolution is independent of the CI image's
  // installed agents (resolveRuntimeId also checks status === "available").
  const env = {
    BIVY_CLAUDE_COMMAND: process.execPath,
    BIVY_CODEX_BIN: process.execPath,
    ...overrides,
  };
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

test("resolveRuntimeId resolves declared aliases to their canonical id", () => {
  withEnv({}, () => {
    const host = makeHost();
    // The friendly aliases declared by the integrations, exercised the way the
    // session/exec API receives them. Claude Code is pinned available above so
    // the resolution isn't masked by the availability gate; the broader alias
    // map (open-code, gemini-cli, …) is covered in agent-registry.test.ts.
    assert.equal(host.resolveRuntimeId("claude", "pi"), "claude-code-sdk");
    assert.equal(host.resolveRuntimeId("claude-code", "pi"), "claude-code-sdk");
  });
});

test("resolveRuntimeId still accepts the exact canonical id", () => {
  withEnv({}, () => {
    const host = makeHost();
    assert.equal(host.resolveRuntimeId("claude-code-sdk", "pi"), "claude-code-sdk");
    assert.equal(host.resolveRuntimeId(undefined, "pi"), "pi");
  });
});

test("resolveRuntimeId rejects a genuinely unknown agent with the requested name", () => {
  withEnv({}, () => {
    const host = makeHost();
    assert.throws(() => host.resolveRuntimeId("totally-not-an-agent", "pi"), /Unknown agent: totally-not-an-agent/);
  });
});
