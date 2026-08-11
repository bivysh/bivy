// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Phase 5b: the ingest policy is the user's choice. Default `merge` keeps the
// historical behavior (a native login folds into the provider's synced default);
// `separate` (opt-in via credentials.config.json) keeps a native login as a
// distinct, node-local credential under a reserved label — it never clobbers a
// Bivy key. Uses an isolated <appDir>/credentials layout so the config file is
// scoped to the test, not a shared /tmp path.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseIngestPolicy, loadIngestPolicy, defaultPresetsPath } from "../src/credentials/presets.js";
import { createCredentialVault } from "../src/runtime/credential-store.js";
import { ingestAgentCredentials } from "../src/runtime/credential-ingest.js";

// --- pure parse/load defaults -----------------------------------------------
assert.equal(parseIngestPolicy({ ingest: { policy: "separate" } }), "separate");
assert.equal(parseIngestPolicy({ ingest: { policy: "nonsense" } }), "merge", "unknown → merge");
assert.equal(parseIngestPolicy({}), "merge", "absent → merge (historical behavior)");

/** An <appDir>/credentials layout so the config sibling is inside the test dir. */
function isolatedApp(policy?: "merge" | "separate"): { appDir: string; credsDir: string } {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-ingest-pol-"));
  const credsDir = path.join(appDir, "credentials");
  fs.mkdirSync(credsDir, { recursive: true });
  if (policy) fs.writeFileSync(defaultPresetsPath(credsDir), JSON.stringify({ ingest: { policy } }));
  return { appDir, credsDir };
}

function writeCodexLogin(accountId: string): string {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-ingest-pol-codex-"));
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: "at-codex", refresh_token: "rt-codex", account_id: accountId } }),
  );
  return codexHome;
}

// --- default (merge): a native login folds into provider:default ------------
{
  const { appDir, credsDir } = isolatedApp(); // no config → merge
  const codexHome = writeCodexLogin("acct-1");
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    assert.equal(loadIngestPolicy(defaultPresetsPath(credsDir)), "merge");
    const imported = await ingestAgentCredentials("codex", credsDir, credsDir);
    assert.equal(imported, 1);
    // merged into the provider's default slot — read-by-provider still works.
    const def = await createCredentialVault(credsDir).read("openai-codex");
    assert.equal((def as { refresh?: string })?.refresh, "rt-codex", "native login lands in the default slot");
    const records = await createCredentialVault(credsDir).listRecords();
    assert.equal(records.filter((r) => r.provider === "openai-codex").length, 1, "one credential, not a separate one");
    assert.equal(records[0].label, "default");
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
}

// --- separate: a native login is a distinct node-local credential -----------
{
  const { appDir, credsDir } = isolatedApp("separate");
  const codexHome = writeCodexLogin("acct-9");
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    // a pre-existing Bivy-managed default must NOT be clobbered.
    await createCredentialVault(credsDir).setApiKey("openai-codex", "sk-bivy-default");

    const imported = await ingestAgentCredentials("codex", credsDir, credsDir);
    assert.equal(imported, 1, "the native login is added as a new labeled record");

    const records = await createCredentialVault(credsDir).listRecords();
    const codex = records.filter((r) => r.provider === "openai-codex");
    assert.equal(codex.length, 2, "the Bivy default and the agent-native login coexist");

    const def = codex.find((r) => r.label === "default");
    assert.equal(def?.source.kind === "stored" && def.source.cred.type === "api_key" ? def.source.cred.key : undefined,
      "sk-bivy-default", "the Bivy default is untouched");

    const native = codex.find((r) => r.label !== "default");
    assert.ok(native, "a separate agent-native record exists");
    assert.equal(native?.origin, "agent-native");
    assert.equal(native?.sync, "node", "an ingested credential stays node-local");
    assert.ok(native?.label.startsWith("codex"), "landed under a reserved agent-derived label (with account id)");
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
}

console.log("credential-ingest-policy: all tests passed");
