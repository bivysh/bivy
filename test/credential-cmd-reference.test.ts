// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// A `cmd://` reference runs a command and uses its stdout as the secret — the
// generic escape hatch for any password-manager CLI. It resolves per-node at read
// time and is FORCED node-local (a synced command would run on every node), so it
// never enters the cross-node sync snapshot.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCredentialVault } from "../src/runtime/credential-store.js";
import { createCredentialStore } from "../src/runtime/credentials.js";
import { setProviderReference, exportSyncableRecords, setCredentialSync, importCredentialRecords } from "../src/credentials/api.js";
import { inferReferenceBackend, credKey, type CredentialRecord } from "../src/credentials/records.js";

// --- scheme inference -------------------------------------------------------
assert.equal(inferReferenceBackend("cmd://printf secret"), "command");
assert.equal(inferReferenceBackend("op://a/b/c"), "1password");
assert.equal(inferReferenceBackend("env://X"), "env");

function freshCredsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-cmd-ref-"));
  const credsDir = path.join(dir, "credentials");
  fs.mkdirSync(credsDir, { recursive: true });
  return credsDir;
}

// --- resolves via the command's stdout; stores only the pointer -------------
{
  const credsDir = freshCredsDir();
  // The secret lives in a file (as it would in a real manager); the command only
  // references the path — so it must NOT appear in the stored record.
  const secretFile = path.join(path.dirname(credsDir), "secret.txt");
  fs.writeFileSync(secretFile, "sk-from-cmd\n");
  try {
    await setProviderReference(credsDir, "anthropic", `cmd://cat ${secretFile}`);

    const record = await createCredentialVault(credsDir).readRecord("anthropic", "default");
    assert.equal(record?.source.kind, "reference");
    assert.equal(record?.source.kind === "reference" ? record.source.backend : "", "command");
    assert.equal(record?.sync, "node", "a cmd:// reference is forced node-local");
    assert.ok(!JSON.stringify(record).includes("sk-from-cmd"), "the secret is never stored (only the command)");

    const resolved = await createCredentialStore(credsDir).getCredential("anthropic");
    assert.equal(resolved?.kind, "api_key");
    assert.equal(resolved?.token, "sk-from-cmd", "resolves to the command's trimmed stdout");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- a cmd:// reference NEVER enters the sync snapshot ----------------------
{
  const credsDir = freshCredsDir();
  try {
    await setProviderReference(credsDir, "anthropic", "cmd://printf 'x'");
    assert.deepEqual(await exportSyncableRecords(credsDir), {}, "command references are never synced");

    // …and cannot be promoted to account sync.
    await assert.rejects(() => setCredentialSync(credsDir, "anthropic", "default", "account"), /node-local/);
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- a synced command reference is REJECTED on import (no remote RCE) -------
{
  const credsDir = freshCredsDir();
  try {
    // Simulate a malicious peer's snapshot carrying a cmd:// reference.
    const malicious: Record<string, CredentialRecord> = {
      [credKey("anthropic", "default")]: {
        provider: "anthropic", label: "default", origin: "bivy", sync: "account",
        source: { kind: "reference", ref: "cmd://touch /tmp/pwned", backend: "command" },
      },
    };
    const imported = await importCredentialRecords(credsDir, malicious);
    assert.equal(imported, 0, "a command reference from a snapshot is dropped");
    assert.equal(await createCredentialVault(credsDir).readRecord("anthropic", "default"), undefined,
      "the injected command reference is never stored, so it can never run here");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- a SPOOFED backend can't smuggle a cmd:// past the import guard ---------
{
  const credsDir = freshCredsDir();
  try {
    // Hostile peer labels a cmd:// ref as "1password" to dodge a backend check —
    // but the guard keys on the ref prefix (which the resolver dispatches on).
    const spoofed: Record<string, CredentialRecord> = {
      [credKey("anthropic", "default")]: {
        provider: "anthropic", label: "default", origin: "bivy", sync: "account",
        source: { kind: "reference", ref: "cmd://touch /tmp/pwned", backend: "1password" },
      },
    };
    const imported = await importCredentialRecords(credsDir, spoofed);
    assert.equal(imported, 0, "a cmd:// ref with a spoofed backend is still dropped");
    assert.equal(await createCredentialVault(credsDir).readRecord("anthropic", "default"), undefined,
      "the spoofed command reference never reaches the vault");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

// --- a failing command yields no credential (no fallback) -------------------
{
  const credsDir = freshCredsDir();
  try {
    await setProviderReference(credsDir, "anthropic", "cmd://exit 3");
    const resolved = await createCredentialStore(credsDir).getCredential("anthropic");
    assert.equal(resolved, undefined, "a failing command resolves to no credential");
  } finally {
    fs.rmSync(path.dirname(credsDir), { recursive: true, force: true });
  }
}

console.log("credential-cmd-reference: all tests passed");
