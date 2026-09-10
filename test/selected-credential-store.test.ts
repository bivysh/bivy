// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCredentialVault } from "../src/credentials/store.js";
import { selectedCredentialStore } from "../src/credentials/selected-store.js";
import { defaultPresetsPath } from "../src/credentials/presets.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-selected-accounts-"));
try {
  const credsDir = path.join(dir, "credentials");
  const vault = createCredentialVault(credsDir);
  for (const provider of ["anthropic", "openai-codex"]) {
    for (const label of ["default", "work"]) await vault.modifyRecord(provider, label, async () => ({ type: "oauth", access: `${provider}-${label}`, refresh: `${label}-refresh`, expires: Date.now() + 3_600_000 }));
  }
  const store = selectedCredentialStore(vault, credsDir, { workspace: path.join(dir, "acme__app", "worktrees", "session") });
  const config = (presets: object) => fs.writeFileSync(defaultPresetsPath(credsDir), JSON.stringify({ presets }));
  assert.equal((await store.read("anthropic"))?.access, "anthropic-default");
  config({ "project:acme/app": { anthropic: "work", "openai-codex": "work" } });
  for (const provider of ["anthropic", "openai-codex"]) assert.equal((await store.read(provider))?.access, `${provider}-work`, "routing changes must take effect without rebuilding the store");
  assert.equal((await store.list()).length, 2, "one selected credential per provider, not duplicate models per label");
  await store.modify("anthropic", async (current) => ({ ...current!, access: "rotated-work" }));
  assert.equal((await store.read("anthropic"))?.access, "rotated-work");
  assert.equal((await vault.read("anthropic"))?.access, "anthropic-default", "refreshing work must not overwrite default");
  assert.equal((await vault.readRecord("anthropic", "work"))?.label, "work");
  config({ default: { anthropic: "work" } });
  assert.equal((await store.read("anthropic"))?.access, "rotated-work");
  config({ "project:acme/app": { anthropic: "missing" } });
  assert.equal(await store.read("anthropic"), undefined, "a dangling account mapping must not use default");
  assert.ok(!(await store.list()).some((record) => record.providerId === "anthropic"));
  await assert.rejects(store.modify("anthropic", async (current) => current), /No account selected/);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("selected credential store OK");
