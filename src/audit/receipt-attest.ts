// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Node EVIDENCE attestation. A Receipt is projected
// downstream (web/control-plane) from the payload-free governance evidence the
// NODE authored (`receiptEvidenceForRun`). This signs that node-authored evidence
// with the node's audit key — the same key that signs the audit trail — and
// anchors it to the audit chain head it summarises. Verification proves the node
// observed exactly these facts and they were not altered in transit, turning the
// downstream receipt from "observation report" into an attested claim.
//
// Deliberately node-only and @bivy/core-free (the daemon never imports the
// browser-shared core): it signs a canonical serialization of the evidence plus
// a small header, so any verifier — including a future WebCrypto one in the PWA —
// can re-derive the exact signed bytes.

import crypto from "node:crypto";
import { type AuditSigner, canonicalize } from "./integrity.js";

/** Node-authored header bound into the signature alongside the evidence. */
export interface AttestationHeader {
  /** When the node produced this attestation (ISO 8601). */
  createdAt: string;
  /** The run this evidence belongs to, when known. */
  runId?: string;
  /** The machine that observed it, when known. */
  machineId?: string;
  /** Hash of the last audit entry this run covers — ties the evidence to the
   *  tamper-evident audit segment behind it. */
  auditChainHead?: string;
}

export interface EvidenceAttestation extends AttestationHeader {
  /** sha256 digest of the canonical {header, evidence}, Ed25519-signed. */
  alg: "sha256-ed25519";
  keyId: string;
  hash: string;
  sig: string;
}

export interface AttestedEvidence<E = unknown> {
  evidence: E;
  attestation: EvidenceAttestation;
}

/** The exact bytes that get signed: a canonical serialization of the header
 *  fields plus the evidence, so sign + verify never drift. */
function digestOf(header: AttestationHeader, evidence: unknown): string {
  const content = {
    createdAt: header.createdAt,
    ...(header.runId ? { runId: header.runId } : {}),
    ...(header.machineId ? { machineId: header.machineId } : {}),
    ...(header.auditChainHead ? { auditChainHead: header.auditChainHead } : {}),
    evidence,
  };
  return crypto.createHash("sha256").update(canonicalize(content)).digest("hex");
}

/** Sign node-authored governance evidence. */
export function attestEvidence<E>(evidence: E, signer: AuditSigner, header: AttestationHeader): AttestedEvidence<E> {
  const hash = digestOf(header, evidence);
  return {
    evidence,
    attestation: {
      alg: "sha256-ed25519",
      keyId: signer.keyId,
      hash,
      sig: signer.sign(hash),
      createdAt: header.createdAt,
      ...(header.runId ? { runId: header.runId } : {}),
      ...(header.machineId ? { machineId: header.machineId } : {}),
      ...(header.auditChainHead ? { auditChainHead: header.auditChainHead } : {}),
    },
  };
}

export interface AttestationVerifyResult {
  ok: boolean;
  reason?: string;
}

/** Verify attested evidence: re-derive the digest from the evidence + header and
 *  check the signature against the named public key. Detects any edit to the
 *  evidence or header (digest mismatch) and a forged/unknown-key signature. */
export function verifyEvidenceAttestation(
  attested: AttestedEvidence,
  publicKeys: Record<string, string>,
): AttestationVerifyResult {
  const { evidence, attestation } = attested;
  if (attestation.alg !== "sha256-ed25519") return { ok: false, reason: `unsupported alg ${attestation.alg}` };
  const pub = publicKeys[attestation.keyId];
  if (!pub) return { ok: false, reason: `no public key for keyId ${attestation.keyId}` };
  const recomputed = digestOf(attestation, evidence);
  if (recomputed !== attestation.hash) return { ok: false, reason: "digest mismatch (evidence or header was edited)" };
  const good = crypto.verify(null, Buffer.from(attestation.hash, "hex"), pub, Buffer.from(attestation.sig, "base64"));
  return good ? { ok: true } : { ok: false, reason: "signature invalid" };
}
