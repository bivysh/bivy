// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Phase 6 (part 2): the record-shaped sync wire. exportSyncableRecords →
// importCredentialRecords carries non-default labels and reference POINTERS
// between nodes (a node-local `sync:"node"` credential never leaves), and
// tombstones converge. Simulates two nodes via two vault dirs.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCredentialVault, type CredentialRecord } from "../src/runtime/credential-store.js";
import {
  exportSyncableRecords,
  exportRecordTombstones,
  importCredentialRecords,
  setProviderApiKeyLabeled,
  setProviderReferenceLabeled,
  setCredentialSync,
} from "../src/credentials/api.js";
import { credKey } from "../src/credentials/records.js";

function freshCredsDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bivy-recsync-${tag}-`));
  const credsDir = path.join(dir, "credentials");
  fs.mkdirSync(credsDir, { recursive: true });
  return credsDir;
}

const A = freshCredsDir("A");
const B = freshCredsDir("B");
try {
  const storeA = createCredentialVault(A);
  // Node A: a default key, a second labeled account, a password-manager reference,
  // and a node-local key that must NOT sync.
  await storeA.setApiKey("anthropic", "sk-default");
  await setProviderApiKeyLabeled(A, "anthropic", "work", "sk-work");
  await setProviderReferenceLabeled(A, "openai", "vault", "op://Team/OpenAI/key");
  await setProviderApiKeyLabeled(A, "groq", "local", "sk-groq-local");
  await setCredentialSync(A, "groq", "local", "node"); // opt this one out of sync

  // --- the record-shaped snapshot excludes node-local, includes references ---
  const snapshot = await exportSyncableRecords(A);
  const keys = Object.keys(snapshot).sort();
  assert.deepEqual(keys, [credKey("anthropic", "default"), credKey("anthropic", "work"), credKey("openai", "vault")].sort(),
    "syncs default + non-default + reference; NOT the node-local groq");
  assert.ok(!JSON.stringify(snapshot).includes("sk-groq-local"), "a node-local secret never enters the snapshot");
  // The reference travels as a pointer only — no secret.
  const refRecord = snapshot[credKey("openai", "vault")] as CredentialRecord;
  assert.equal(refRecord.source.kind, "reference");
  assert.equal(refRecord.source.kind === "reference" ? refRecord.source.ref : "", "op://Team/OpenAI/key");

  // --- Node B imports the snapshot (record-shaped) ---------------------------
  const imported = await importCredentialRecords(B, snapshot, await exportRecordTombstones(A));
  assert.equal(imported, 3, "three records land on the peer");
  const storeB = createCredentialVault(B);
  assert.equal((await storeB.readRecord("anthropic", "default"))?.source.kind === "stored" ? "ok" : "no", "ok");
  assert.equal((await storeB.readRecord("anthropic", "work"))?.label, "work", "the non-default account synced");
  const bRef = await storeB.readRecord("openai", "vault");
  assert.equal(bRef?.source.kind, "reference", "the reference pointer synced (secret resolved per-node)");
  assert.equal(await storeB.readRecord("groq", "local"), undefined, "the node-local credential did NOT sync");

  // --- a deletion converges via record tombstones ----------------------------
  await storeA.deleteRecord("anthropic", "work");
  const tombstones = await exportRecordTombstones(A);
  assert.ok(tombstones[credKey("anthropic", "work")] > 0, "A holds a tombstone for the removed account");
  await importCredentialRecords(B, await exportSyncableRecords(A), tombstones);
  assert.equal(await storeB.readRecord("anthropic", "work"), undefined, "the deletion converged to the peer");
  assert.ok(await storeB.readRecord("anthropic", "default"), "the default credential is unaffected");

  console.log("credential-record-sync: all tests passed");
} finally {
  fs.rmSync(path.dirname(A), { recursive: true, force: true });
  fs.rmSync(path.dirname(B), { recursive: true, force: true });
}
