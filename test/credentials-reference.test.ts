// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// A reference credential (op:// / env://) is a pointer resolved per-node
// at read time via the secret vault — the secret never enters the credential
// vault. Exercised end-to-end with an env:// pointer (op:// needs the `op` CLI).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { seal, open } from "../src/e2e.js";
import { createCredentialVault } from "../src/runtime/credential-store.js";
import { createCredentialStore } from "../src/runtime/credentials.js";
import { setProviderReference } from "../src/credentials/api.js";
import { inferReferenceBackend } from "../src/credentials/records.js";

// --- inferReferenceBackend --------------------------------------------------
assert.equal(inferReferenceBackend("op://Vault/Item/field"), "1password");
assert.equal(inferReferenceBackend("env://MY_KEY"), "env");
assert.equal(inferReferenceBackend("secret://x"), undefined);
assert.equal(inferReferenceBackend("plain"), undefined);

function freshCredsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-ref-"));
  const credsDir = path.join(dir, "credentials");
  fs.mkdirSync(credsDir, { recursive: true });
  return credsDir;
}

// --- a reference stores only the pointer, then resolves per-node ------------
{
  const credsDir = freshCredsDir();
  const envName = "BIVY_TEST_REF_KEY_A";
  process.env[envName] = "sk-from-env";
  try {
    await setProviderReference(credsDir, "anthropic", `env://${envName}`);

    // On disk it is a reference record — the secret is NOT persisted.
    const key = Buffer.from(fs.readFileSync(path.join(credsDir, "auth.key"), "utf8").trim(), "base64");
    const doc = JSON.parse(open(key, fs.readFileSync(path.join(credsDir, "auth.enc"), "utf8").trim()));
    const record = doc.credentials["anthropic:default"];
    assert.equal(record.source.kind, "reference");
    assert.equal(record.source.ref, `env://${envName}`);
    assert.equal(record.source.backend, "env");
    assert.ok(!JSON.stringify(record).includes("sk-from-env"), "the secret is never stored");

    // The resolver resolves the pointer to an api-key credential at read time.
    const resolved = await createCredentialStore(credsDir).getCredential("anthropic");
    assert.equal(resolved?.kind, "api_key");
    assert.equal(resolved?.token, "sk-from-env");
  } finally {
    delete process.env[envName];
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- an unresolvable reference reports no credential (no fallback) ----------
{
  const credsDir = freshCredsDir();
  try {
    await setProviderReference(credsDir, "anthropic", "env://BIVY_TEST_REF_MISSING");
    const resolved = await createCredentialStore(credsDir).getCredential("anthropic");
    assert.equal(resolved, undefined, "a missing env var yields no credential, not a fallback");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- setProviderReference rejects a non-pointer -----------------------------
{
  const credsDir = freshCredsDir();
  try {
    await assert.rejects(() => setProviderReference(credsDir, "anthropic", "sk-plain-key"), /op:\/\/, env:\/\/, or cmd:\/\//);
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- a reference and a stored key coexist; export stays provider-keyed -------
{
  const credsDir = freshCredsDir();
  const envName = "BIVY_TEST_REF_KEY_B";
  process.env[envName] = "sk-ref-b";
  try {
    const store = createCredentialVault(credsDir);
    await store.setApiKey("openai", "sk-stored");
    await store.setReference("anthropic", `env://${envName}`, "env");

    // exportAll (the sync wire) carries the stored key but never a resolved
    // reference secret — only the stored credential is a syncable value.
    const exported = await store.exportAll();
    assert.equal((exported.openai as any).key, "sk-stored");
    assert.ok(!("anthropic" in exported) || !JSON.stringify(exported.anthropic).includes("sk-ref-b"),
      "a reference's resolved secret never enters exportAll");

    const resolved = await createCredentialStore(credsDir).getCredential("anthropic");
    assert.equal(resolved?.token, "sk-ref-b");
  } finally {
    delete process.env[envName];
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

console.log("credentials-reference: all tests passed");
