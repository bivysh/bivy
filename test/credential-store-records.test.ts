// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Phase 5: the record-addressed store CRUD + labeled daemon API — multiple
// credentials per provider (work / personal / per-project). The single-credential
// path is the label="default" special case, and must stay unchanged.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCredentialVault } from "../src/runtime/credential-store.js";
import { createCredentialStore } from "../src/runtime/credentials.js";
import type { CredentialRecord } from "../src/credentials/records.js";
import {
  listCredentialRecords,
  setProviderApiKeyLabeled,
  setProviderReferenceLabeled,
  removeProviderCredential,
} from "../src/runtime/pi-auth.js";

function freshCredsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-cred-rec-"));
  const credsDir = path.join(dir, "credentials");
  fs.mkdirSync(credsDir, { recursive: true });
  return credsDir;
}

function apiRecord(provider: string, label: string, key: string): CredentialRecord {
  return { provider, label, origin: "bivy", sync: "account", source: { kind: "stored", cred: { type: "api_key", key } } };
}

// --- putRecord / readRecord / deleteRecord round-trip -----------------------
{
  const credsDir = freshCredsDir();
  try {
    const store = createCredentialVault(credsDir);
    await store.putRecord(apiRecord("anthropic", "work", "sk-work"));
    await store.putRecord(apiRecord("anthropic", "personal", "sk-personal"));

    const work = await store.readRecord("anthropic", "work");
    assert.equal(work?.source.kind === "stored" && work.source.cred.type === "api_key" ? work.source.cred.key : undefined, "sk-work");
    assert.equal(typeof work?.updatedAt, "number", "putRecord stamps the store-owned updatedAt");

    const all = await store.listRecords();
    assert.equal(all.filter((r) => r.provider === "anthropic").length, 2, "two labeled accounts coexist");

    await store.deleteRecord("anthropic", "work");
    assert.equal(await store.readRecord("anthropic", "work"), undefined, "deleted label is gone");
    assert.ok(await store.readRecord("anthropic", "personal"), "the other label survives");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- importRecords is rotation-safe (freshest local OAuth wins) -------------
{
  const credsDir = freshCredsDir();
  try {
    const store = createCredentialVault(credsDir);
    const fresh: CredentialRecord = {
      provider: "openai-codex", label: "codex", origin: "agent-native", sync: "node",
      source: { kind: "stored", cred: { type: "oauth", access: "new", refresh: "r2", expires: 0, refreshedAt: 200 } },
    };
    await store.putRecord(fresh);
    const stale: CredentialRecord = {
      provider: "openai-codex", label: "codex", origin: "agent-native", sync: "node",
      source: { kind: "stored", cred: { type: "oauth", access: "old", refresh: "r1", expires: 0, refreshedAt: 100 } },
    };
    const imported = await store.importRecords([stale]);
    assert.equal(imported, 0, "a staler snapshot does not add or overwrite");
    const kept = await store.readRecord("openai-codex", "codex");
    assert.equal(kept?.source.kind === "stored" && kept.source.cred.type === "oauth" ? kept.source.cred.access : undefined, "new", "fresher local OAuth kept");

    // A brand-new labeled record from a snapshot is imported.
    const n = await store.importRecords([apiRecord("openai-codex", "second", "sk-2")]);
    assert.equal(n, 1);
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- labeled daemon API + non-secret listing --------------------------------
{
  const credsDir = freshCredsDir();
  const envName = "BIVY_TEST_LABELED_REF";
  process.env[envName] = "sk-ref-labeled";
  try {
    await setProviderApiKeyLabeled(credsDir, "anthropic", "work", "sk-work");
    await setProviderApiKeyLabeled(credsDir, "anthropic", "personal", "sk-personal");
    await setProviderReferenceLabeled(credsDir, "openai", "vault", `env://${envName}`);

    const summaries = await listCredentialRecords(credsDir);
    assert.equal(summaries.length, 3);
    const serialized = JSON.stringify(summaries);
    assert.ok(!serialized.includes("sk-work") && !serialized.includes("sk-ref-labeled"), "summaries never expose secrets");
    const anthropicLabels = summaries.filter((s) => s.provider === "anthropic").map((s) => s.label).sort();
    assert.deepEqual(anthropicLabels, ["personal", "work"]);
    const ref = summaries.find((s) => s.provider === "openai");
    assert.equal(ref?.kind, "reference");
    assert.equal(ref?.ref, `env://${envName}`);

    // Re-setting preserves an opted node-local sync policy.
    const store = createCredentialVault(credsDir);
    await store.putRecord({ ...apiRecord("anthropic", "work", "sk-work"), sync: "node" });
    await setProviderApiKeyLabeled(credsDir, "anthropic", "work", "sk-work-rotated");
    assert.equal((await store.readRecord("anthropic", "work"))?.sync, "node", "re-set preserves node-local sync");

    await removeProviderCredential(credsDir, "anthropic", "personal");
    assert.equal((await listCredentialRecords(credsDir)).filter((s) => s.provider === "anthropic").length, 1);
  } finally {
    delete process.env[envName];
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- coexistence keeps the single-credential path working -------------------
{
  const credsDir = freshCredsDir();
  try {
    const store = createCredentialVault(credsDir);
    // A default credential plus a labeled account: the resolver picks the default,
    // so a provider's default login keeps working with no preset (zero-config).
    await store.setApiKey("anthropic", "sk-default");
    await store.putRecord(apiRecord("anthropic", "work", "sk-work"));
    const resolved = await createCredentialStore(credsDir).getCredential("anthropic");
    assert.equal(resolved?.token, "sk-default", "resolver picks the default label when present");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

console.log("credential-store-records: all tests passed");
