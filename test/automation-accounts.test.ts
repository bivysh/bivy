// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeAutomationTemplate, decodeAutomationTemplate } from "../src/automation-template.js";
import { seal, open } from "../src/e2e.js";
import { createCredentialVault } from "../src/credentials/store.js";
import { selectedCredentialStore } from "../src/credentials/selected-store.js";
import { createCredentialStore, buildAgentCredentialEnv } from "../src/credentials/resolver.js";
import { withSessionCredentials } from "../src/credentials/session.js";
import { ProcessRuntime } from "../src/runtime/process.js";

assert.equal(fs.readFileSync("src/automation-template.ts", "utf8"), fs.readFileSync("packages/core/src/automation-template.ts", "utf8"));
const labels = { anthropic: "work", "openai-codex": "personal" };
const instructions = "Review the code.\nKeep this verbatim.";
const encrypted = seal(Buffer.alloc(32, 4), encodeAutomationTemplate(instructions, labels));
assert.deepEqual(decodeAutomationTemplate(open(Buffer.alloc(32, 4), encrypted)), { instructions, credentialLabels: labels });
assert.equal(encodeAutomationTemplate(instructions, {}), instructions);
assert.deepEqual(decodeAutomationTemplate(instructions), { instructions, credentialLabels: {} });
const prefixed = "bivy-automation-v1\nordinary instructions";
assert.equal(decodeAutomationTemplate(encodeAutomationTemplate(prefixed, {})).instructions, prefixed);
for (const value of ["{}", '{"instructions":"x","credentialLabels":[]}', '{"instructions":"x","credentialLabels":{"anthropic":42}}']) {
  assert.throws(() => decodeAutomationTemplate("bivy-automation-v1\n" + value));
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-automation-accounts-"));
try {
  const credsDir = path.join(dir, "credentials");
  const vault = createCredentialVault(credsDir);
  for (const provider of ["anthropic", "openai-codex"]) {
    for (const label of ["default", "work", "personal"]) {
      await vault.modifyRecord(provider, label, async () => ({ type: "oauth", access: `${provider}-${label}`, refresh: "refresh", expires: Date.now() + 3_600_000 }));
    }
  }
  fs.writeFileSync(path.join(dir, "credentials.config.json"), JSON.stringify({ presets: { default: { anthropic: "personal" } } }));
  const pinned = selectedCredentialStore(vault, credsDir, { credentialLabels: labels });
  const defaults = selectedCredentialStore(vault, credsDir);
  assert.equal((await pinned.read("anthropic"))?.access, "anthropic-work");
  assert.equal((await pinned.read("openai-codex"))?.access, "openai-codex-personal");
  assert.equal((await defaults.read("anthropic"))?.access, "anthropic-personal");
  await pinned.modify("anthropic", async (current) => ({ ...current!, access: "rotated-work" }));
  assert.equal((await pinned.read("anthropic"))?.access, "rotated-work");
  assert.equal((await defaults.read("anthropic"))?.access, "anthropic-personal");
  const missing = selectedCredentialStore(vault, credsDir, { credentialLabels: { anthropic: "deleted" } });
  await assert.rejects(missing.read("anthropic"), /Selected account/);
  await assert.rejects(missing.list(), /Selected account/);
  await assert.rejects(missing.modify("anthropic", async (current) => current), /Selected account/);
  await assert.rejects(selectedCredentialStore(vault, credsDir, { credentialLabels: { missing: "work" } }).list(), /Selected account/);

  const resolver = createCredentialStore(credsDir, { resolve: async () => undefined }, { refresh: async () => undefined });
  const scoped = await withSessionCredentials({ credentials: resolver }, { anthropic: "work" });
  assert.equal((await buildAgentCredentialEnv(scoped.credentials)).CLAUDE_CODE_OAUTH_TOKEN, "rotated-work");
  assert.equal((await buildAgentCredentialEnv(resolver)).CLAUDE_CODE_OAUTH_TOKEN, "anthropic-personal");
  await assert.rejects(withSessionCredentials({}, { anthropic: "work" }), /manages its own login/);
  await assert.rejects(withSessionCredentials({ credentials: resolver }, { anthropic: "deleted" }), /Selected account/);
  await assert.rejects(withSessionCredentials({ credentials: resolver }, { "openai-codex": "personal" }), /subscription override/);
  const runtime = new ProcessRuntime({ id: "account-test", command: process.execPath, args: ["-e", "console.log(process.env.CLAUDE_CODE_OAUTH_TOKEN)"], promptMode: "stdin", credentials: resolver });
  const run = async (credentialLabels?: Record<string, string>) => {
    const { session } = await runtime.createSession({ workspace: dir, credentialLabels });
    try {
      const done = new Promise<void>((resolve) => session.subscribe((event) => { if (event.type === "agent_end") resolve(); }));
      await session.prompt("test");
      await done;
      return JSON.stringify(session.getMessages());
    } finally { session.dispose(); }
  };
  const [workRun, defaultRun] = await Promise.all([run({ anthropic: "work" }), run()]);
  assert.match(workRun, /rotated-work/);
  assert.doesNotMatch(workRun, /anthropic-personal/);
  assert.match(defaultRun, /anthropic-personal/);

  await vault.modifyRecord("anthropic", "work", async () => ({ type: "api_key", key: "work-key" }));
  assert.equal((await buildAgentCredentialEnv(scoped.credentials)).ANTHROPIC_API_KEY, "work-key");
  assert.equal((await buildAgentCredentialEnv(scoped.credentials)).CLAUDE_CODE_OAUTH_TOKEN, "", "a pinned API key must clear the competing ambient subscription");
  await vault.deleteRecord("anthropic", "work");
  await assert.rejects(buildAgentCredentialEnv(scoped.credentials), /Selected account/, "deletion during a session must not fall back to another account");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
let readFailed = false;
const flaky = await withSessionCredentials({ credentials: {
  listConfigured: async () => { throw new Error("listing failed"); },
  getCredential: async () => {
    if (readFailed) throw new Error("vault unavailable");
    return { provider: "openai", kind: "api_key" as const, token: "pinned-key" };
  },
} }, { openai: "work" });
assert.equal((await buildAgentCredentialEnv(flaky.credentials)).OPENAI_API_KEY, "pinned-key");
readFailed = true;
await assert.rejects(buildAgentCredentialEnv(flaky.credentials), /Could not read selected account/);
console.log("automation account selection OK");
