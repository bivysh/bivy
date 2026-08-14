import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { claudeCodeIntegration } from "../src/agents/claude-code/integration.js";
import { invalidateClaudeCliProbe } from "../src/agents/claude-code/runtime.js";
import { setProviderApiKey } from "../src/credentials/api.js";

// Regression (#433/#435): the unified agent integration's create() must forward
// the node's shared credential vault into the Claude Code runtime. When it
// doesn't, resolveCredentialEnv() returns {} and every turn fails preflight with
// "Claude Code has no Anthropic credential on this node" even though the user
// signed in — the PWA sign-in breakage introduced by the decomplect refactor.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-claude-cred-"));
  const credsDir = path.join(dir, "credentials");
  fs.mkdirSync(credsDir, { recursive: true });
  await setProviderApiKey(credsDir, "anthropic", "sk-test-vault-key");

  // create() and interactiveTuiCommand() both gate on the `claude` CLI being on
  // PATH; point the probe at `node` (always present) so neither short-circuits.
  const prevCommand = process.env.BIVY_CLAUDE_COMMAND;
  process.env.BIVY_CLAUDE_COMMAND = "node";
  invalidateClaudeCliProbe();
  try {
    const integration = claudeCodeIntegration({ kind: "config" });
    assert.ok(integration.create, "the claude integration exposes create()");
    const runtime = integration.create({ credsDir, piDir: dir, sessionsDir: dir });
    const { session } = await runtime.createSession({ workspace: dir });

    // interactiveTuiCommand() resolves the credential env without spawning a
    // subprocess, so it reads out exactly what create() wired into the runtime.
    const tui = await (session as unknown as { interactiveTuiCommand(): Promise<{ env: Record<string, string> } | null> }).interactiveTuiCommand();
    assert.ok(tui, "interactiveTuiCommand resolves when the claude CLI is available");
    assert.equal(
      tui.env.ANTHROPIC_API_KEY,
      "sk-test-vault-key",
      "create() forwards the vault credential into the SDK subprocess env",
    );
  } finally {
    if (prevCommand === undefined) delete process.env.BIVY_CLAUDE_COMMAND;
    else process.env.BIVY_CLAUDE_COMMAND = prevCommand;
    invalidateClaudeCliProbe();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("claude create() forwards vault credential OK");
}

console.log("claude-code credentials: all tests passed");
