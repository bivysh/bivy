// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadOrCreateAuditKey } from "../src/audit/integrity.js";
import { attestEvidence, verifyEvidenceAttestation } from "../src/audit/receipt-attest.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-receipt-"));
}

// Shaped like the payload-free evidence receiptEvidenceForRun emits.
function sampleEvidence() {
  return {
    approvals: { requests: 2, approved: 1, denied: 1 },
    fileChanges: { files: [{ path: "src/a.ts", op: "modified", added: 3, removed: 1 }], added: 3, removed: 1 },
    auditHealth: { correlation: "healthy", readableStorage: "healthy", successfulWrites: "healthy" },
    execution: { profile: "trusted_workstation", controller: "customer", modelVersionStatus: "available" },
  };
}

test("attested evidence verifies against the audit key", () => {
  const key = loadOrCreateAuditKey(tmpDir());
  const attested = attestEvidence(sampleEvidence(), key.signer, {
    createdAt: "2026-08-15T00:02:00.000Z",
    runId: "run_1",
    machineId: "m1",
    auditChainHead: "deadbeef",
  });
  assert.equal(attested.attestation.alg, "sha256-ed25519");
  assert.equal(attested.attestation.keyId, key.keyId);
  assert.equal(attested.attestation.auditChainHead, "deadbeef");

  const res = verifyEvidenceAttestation(attested, { [key.keyId]: key.publicKeyPem });
  assert.equal(res.ok, true);
});

test("editing an observed fact invalidates the attestation", () => {
  const key = loadOrCreateAuditKey(tmpDir());
  const attested = attestEvidence(sampleEvidence(), key.signer, { createdAt: "2026-08-15T00:02:00.000Z" });
  (attested.evidence as any).approvals.approved = 999;
  const res = verifyEvidenceAttestation(attested, { [key.keyId]: key.publicKeyPem });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /digest mismatch/);
});

test("editing the header (e.g. auditChainHead) invalidates it", () => {
  const key = loadOrCreateAuditKey(tmpDir());
  const attested = attestEvidence(sampleEvidence(), key.signer, { createdAt: "2026-08-15T00:02:00.000Z", auditChainHead: "aaa" });
  attested.attestation.auditChainHead = "bbb";
  const res = verifyEvidenceAttestation(attested, { [key.keyId]: key.publicKeyPem });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /digest mismatch/);
});

test("an unknown key id is rejected", () => {
  const key = loadOrCreateAuditKey(tmpDir());
  const attested = attestEvidence(sampleEvidence(), key.signer, { createdAt: "2026-08-15T00:02:00.000Z" });
  const res = verifyEvidenceAttestation(attested, { "other-key": key.publicKeyPem });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /no public key/);
});

test("a signature from a different key fails", () => {
  const good = loadOrCreateAuditKey(tmpDir());
  const evil = loadOrCreateAuditKey(tmpDir());
  const attested = attestEvidence(sampleEvidence(), evil.signer, { createdAt: "2026-08-15T00:02:00.000Z" });
  attested.attestation.keyId = good.keyId; // claim it was good's key
  const res = verifyEvidenceAttestation(attested, { [good.keyId]: good.publicKeyPem });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /signature invalid/);
});
