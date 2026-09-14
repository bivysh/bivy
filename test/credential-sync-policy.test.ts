// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Per-credential opt-out sync (exportSyncable filters `sync:"node"`) and
// record-addressed writes (modifyRecord targets a specific provider:label, so a
// refresh/rotation on one account never touches another). Pure store behavior.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCredentialVault } from "../src/runtime/credential-store.js";
import type { CredentialRecord } from "../src/credentials/records.js";
import { exportAccountOAuthCredentials, exportUnattendedRecords, importAccountOAuthCredentials, reconcileHostedCredentialRecords, setCredentialUnattended, setProviderApiKeyLabeled } from "../src/credentials/api.js";

function freshCredsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-sync-pol-"));
  const credsDir = path.join(dir, "credentials");
  fs.mkdirSync(credsDir, { recursive: true });
  return credsDir;
}

function oauthRecord(provider: string, label: string, access: string, expires: number): CredentialRecord {
  return {
    provider, label, origin: "bivy", sync: "account",
    source: { kind: "stored", cred: { type: "oauth", access, refresh: `r-${label}`, expires } },
  };
}

// --- exportSyncable honors per-credential opt-out ---------------------------
{
  const credsDir = freshCredsDir();
  try {
    const store = createCredentialVault(credsDir);
    await store.setApiKey("anthropic", "sk-synced");   // default → sync "account"
    await store.setApiKey("openai", "sk-local");

    // Opt openai's default credential out of sync.
    await store.putRecord({
      provider: "openai", label: "default", origin: "bivy", sync: "node",
      source: { kind: "stored", cred: { type: "api_key", key: "sk-local" } },
    });

    const all = await store.exportAll();
    assert.ok("anthropic" in all && "openai" in all, "exportAll returns every default credential (local reads)");

    const syncable = await store.exportSyncable();
    assert.ok("anthropic" in syncable, "an account-tier credential is pushed");
    assert.ok(!("openai" in syncable), "a node-local credential is NOT pushed (opt-out)");

    // A reference default carries no syncable secret → never in either provider-keyed export.
    await store.setReference("google", "env://SOME_KEY", "env");
    assert.ok(!("google" in (await store.exportSyncable())), "reference secret never syncs");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- creation persists a requested machine-only tier atomically ------------
{
  const credsDir = freshCredsDir();
  try {
    const store = createCredentialVault(credsDir);
    await setProviderApiKeyLabeled(credsDir, "openai", "work", "node-secret", "node");
    assert.equal((await store.readRecord("openai", "work"))?.sync, "node");
    assert.deepEqual(await store.exportSyncableRecords(), {}, "a newly created machine-only secret is never account-exportable");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- unattended custody is explicit and exports only granted stored items ---
{
  const credsDir = freshCredsDir();
  try {
    const store = createCredentialVault(credsDir);
    await store.setApiKey("anthropic", "personal-key");
    await store.putRecord({ provider: "anthropic", label: "work", origin: "bivy", sync: "account", source: { kind: "stored", cred: { type: "api_key", key: "work-key" } } });
    await store.putRecord({ provider: "openai", label: "team", origin: "bivy", sync: "account", source: { kind: "stored", cred: { type: "api_key", key: "team-key" } } });
    await setCredentialUnattended(credsDir, "anthropic", "work", true);
    await setCredentialUnattended(credsDir, "openai", "team", true);
    const hosted = await exportUnattendedRecords(credsDir);
    assert.deepEqual(Object.keys(hosted).sort(), ["anthropic:work", "openai:team"]);
    assert.equal(hosted["anthropic:work"]?.unattended, true);
    assert.equal(hosted["openai:team"]?.unattended, true);
    assert.equal((await store.readRecord("anthropic", "default"))?.unattended, undefined, "account sync never implies hosted custody");
    await setProviderApiKeyLabeled(credsDir, "anthropic", "work", "rotated-work-key");
    assert.equal((await store.readRecord("anthropic", "work"))?.unattended, true, "rotating a key preserves its custody grant");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- hosted snapshots authoritatively remove revoked custody ----------------
{
  const credsDir = freshCredsDir();
  try {
    const store = createCredentialVault(credsDir);
    const record: CredentialRecord = { provider: "anthropic", label: "work", origin: "bivy", sync: "account", unattended: true, updatedAt: 10, source: { kind: "stored", cred: { type: "api_key", key: "hosted-key" } } };
    const manifest = await reconcileHostedCredentialRecords(credsDir, { "anthropic:work": record }, []);
    assert.equal((await store.readRecord("anthropic", "work"))?.source.kind, "stored");
    assert.deepEqual(manifest, [{ provider: "anthropic", label: "work" }]);
    assert.deepEqual(await reconcileHostedCredentialRecords(credsDir, {}, manifest), []);
    assert.equal(await store.readRecord("anthropic", "work"), undefined, "omission from the next filtered snapshot revokes a running hosted recipient");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- browser OAuth recovery advances rotations but cannot replace key kinds --
{
  const credsDir = freshCredsDir();
  try {
    const store = createCredentialVault(credsDir);
    await store.putRecord({ ...oauthRecord("anthropic", "default", "old", 2_000), source: { kind: "stored", cred: { type: "oauth", access: "old", refresh: "refresh-old", expires: 2_000, refreshedAt: 1_000 } } });
    await importAccountOAuthCredentials(credsDir, [{ provider: "anthropic", label: "default", access: "new", refresh: "refresh-new", expires: 4_000, refreshedAt: 3_000, updatedAt: 3_000 }]);
    assert.equal((await exportAccountOAuthCredentials(credsDir))[0]?.refresh, "refresh-new");

    await store.setApiKey("openai", "intentional-key");
    await importAccountOAuthCredentials(credsDir, [{ provider: "openai", label: "default", access: "stale", refresh: "stale-refresh", expires: 9_000, refreshedAt: 8_000 }]);
    assert.equal((await store.read("openai"))?.type, "api_key", "browser recovery never undoes a credential type switch");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- modifyRecord targets one label; a sibling account is untouched ---------
{
  const credsDir = freshCredsDir();
  try {
    const store = createCredentialVault(credsDir);
    await store.putRecord(oauthRecord("anthropic", "work", "work-access", 0));
    await store.putRecord(oauthRecord("anthropic", "personal", "personal-access", 0));

    // Rotate only the "work" record (as an OAuth refresh would).
    const returned = await store.modifyRecord("anthropic", "work", async (current) => {
      assert.equal(current?.type === "oauth" ? current.access : undefined, "work-access", "sees the work record's cred");
      return { type: "oauth", access: "work-access-v2", refresh: "r-work-v2", expires: 111 };
    });
    assert.equal(returned?.type === "oauth" ? returned.access : undefined, "work-access-v2");

    const work = await store.readRecord("anthropic", "work");
    const personal = await store.readRecord("anthropic", "personal");
    assert.equal(work?.source.kind === "stored" && work.source.cred.type === "oauth" ? work.source.cred.access : undefined, "work-access-v2", "work rotated");
    assert.equal(personal?.source.kind === "stored" && personal.source.cred.type === "oauth" ? personal.source.cred.access : undefined, "personal-access", "personal UNTOUCHED by the work rotation");
    assert.equal(work?.label, "work");
    assert.equal(work?.origin, "bivy");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- modify() is still the label="default" case -----------------------------
{
  const credsDir = freshCredsDir();
  try {
    const store = createCredentialVault(credsDir);
    await store.setApiKey("anthropic", "sk-1");
    await store.modify("anthropic", async () => ({ type: "api_key", key: "sk-2" }));
    assert.equal((await store.read("anthropic") as { key?: string })?.key, "sk-2");
    assert.equal((await store.readRecord("anthropic", "default"))?.label, "default");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

console.log("credential-sync-policy: all tests passed");
