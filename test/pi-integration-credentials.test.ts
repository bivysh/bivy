import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { piIntegration, invalidatePiCommandProbe } from "../src/agents/pi/integration.js";
import { createCredentialVault } from "../src/runtime/credential-store.js";

// Regression (#433): the unified agent integration constructed the daemon-hosted
// Pi with `credentialOwner: "agent"`, which makes the session read Pi's own
// plaintext auth.json (under piAgentDir) instead of Bivy's shared vault. Nothing
// materialises the vault into that file for the chat path, so a user who signed
// in through Bivy saw every provider "Not connected" in the model picker and Pi
// could not authenticate. The integration's create() must stay vault-backed:
// session.getModels() has to surface the providers the vault holds.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-pi-integration-"));
  const credsDir = path.join(dir, "credentials");
  const agentDir = path.join(dir, "agent");
  const sessionsDir = path.join(dir, "sessions");
  fs.mkdirSync(credsDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  // A single Anthropic login lives only in Bivy's shared vault — never written to
  // Pi's plaintext auth.json under the agent dir.
  await createCredentialVault(credsDir).modify("anthropic", async () => ({
    type: "oauth",
    access: "a",
    refresh: "r",
    expires: Date.now() + 3_600_000,
  }));

  // create() gates on the `pi` command being on PATH and reads piAgentDir() from
  // PI_CODING_AGENT_DIR; point both at the temp agent dir / `node`.
  const prevCommand = process.env.BIVY_PI_COMMAND;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.BIVY_PI_COMMAND = "node";
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidatePiCommandProbe();
  try {
    const integration = piIntegration({ kind: "config" });
    assert.ok(integration.create, "the pi integration exposes create()");
    const runtime = integration.create({ credsDir, piDir: dir, sessionsDir });
    const { session } = await runtime.createSession({ workspace: dir });

    const providers = new Set((await session.getModels()).map((model: any) => model.provider));
    assert.ok(
      providers.has("anthropic"),
      "the daemon Pi session must surface vault-stored providers (create() must be vault-backed, not agent-owned)",
    );

    (session as unknown as { dispose?: () => void }).dispose?.();
  } finally {
    if (prevCommand === undefined) delete process.env.BIVY_PI_COMMAND;
    else process.env.BIVY_PI_COMMAND = prevCommand;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    invalidatePiCommandProbe();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("pi integration create() is vault-backed OK");
}

console.log("pi integration credentials: all tests passed");
