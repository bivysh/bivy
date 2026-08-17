// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Audit-trail INTEGRITY. Turns the append-only
// JSONL audit stream from "append-only by convention" into a tamper-EVIDENT
// record, so a receipt can move from "observation report" toward "attestation".
//
// Two layers, each independently useful:
//   1. Hash chain (always on). Every entry carries `seq` (monotonic) and `prev`
//      (the previous entry's hash), and its own `hash` binds them together:
//      hash = sha256(prev + "\n" + canonical(entry-without-prev/hash/sig)).
//      This makes truncation, reordering, and in-place edits DETECTABLE by
//      recomputation — no key required. On its own it does NOT stop an attacker
//      with filesystem access who simply recomputes the whole chain.
//   2. Signature (when a signer is configured). Each entry's hash is signed with
//      the node's Ed25519 audit key. Recomputing the chain now requires the
//      private key, so a privileged tamper is EVIDENT to anyone holding the
//      public key. This is the piece that makes the chain unforgeable.
//
// This module stays a pure leaf: it imports only node:crypto/fs, exactly like
// audit/index.ts, so the audit writer can chain without pulling in the kernel.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Deterministic JSON: object keys sorted recursively, so the hash of an entry
 *  is independent of key insertion order (the verifier re-serializes from a
 *  parsed line and must land on the exact same bytes the writer hashed). */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

/** The three chain fields the writer stamps onto every entry; they are excluded
 *  from the hashed content (the hash is OVER the event, and BINDS `prev`). */
export const CHAIN_FIELDS = ["prev", "hash", "sig"] as const;

/** Compute an entry's chain hash. `entry` is the full event object WITHOUT the
 *  chain fields (ts + seq + the governance fields). */
export function chainHash(prev: string, entry: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(`${prev}\n${canonicalize(entry)}`).digest("hex");
}

/** Split a persisted line's parsed object into (event, chain). */
function splitChain(parsed: Record<string, unknown>): { entry: Record<string, unknown>; prev?: string; hash?: string; sig?: string } {
  const entry: Record<string, unknown> = {};
  let prev: string | undefined;
  let hash: string | undefined;
  let sig: string | undefined;
  for (const [k, v] of Object.entries(parsed)) {
    if (k === "prev") prev = typeof v === "string" ? v : undefined;
    else if (k === "hash") hash = typeof v === "string" ? v : undefined;
    else if (k === "sig") sig = typeof v === "string" ? v : undefined;
    else entry[k] = v;
  }
  return { entry, prev, hash, sig };
}

/** A node-side signer over an entry hash. Kept as an interface so the audit
 *  writer never imports key material directly. */
export interface AuditSigner {
  /** Stable id of the signing key (a fingerprint), stamped as `keyId`. */
  readonly keyId: string;
  /** Sign the hex entry hash, returning a base64 detached signature. */
  sign(hashHex: string): string;
}

/** The running position needed to append the next chained entry. */
export interface ChainState {
  seq: number;
  prev: string;
}

/** Recover the chain head from an existing audit file so a daemon restart
 *  CONTINUES the chain instead of forking a fresh one (which would look like a
 *  truncation to the verifier). Best-effort: an empty/absent/legacy file yields
 *  a genesis state (`seq: 0, prev: ""`). */
export function readChainState(file: string): ChainState {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { seq: 0, prev: "" };
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  if (!lines.length) return { seq: 0, prev: "" };
  const last = lines[lines.length - 1];
  try {
    const parsed = JSON.parse(last) as Record<string, unknown>;
    const seq = typeof parsed.seq === "number" ? parsed.seq : lines.length - 1;
    const hash = typeof parsed.hash === "string" ? parsed.hash : "";
    return { seq: seq + 1, prev: hash };
  } catch {
    // Corrupt tail: continue by position, unchained (verifier flags the gap).
    return { seq: lines.length, prev: "" };
  }
}

/** Stamp `event` with chain (and optional signature) fields, advancing `state`
 *  in place. Returns the object to serialize as one JSONL line. */
export function chainEntry(
  state: ChainState,
  event: Record<string, unknown>,
  signer?: AuditSigner,
): Record<string, unknown> {
  // `keyId` is bound INTO the hashed entry (not appended after) so it is covered
  // by the chain — a key substitution is then a hash mismatch. Only prev/hash/sig
  // stay outside the hash (see CHAIN_FIELDS / the verifier's splitChain).
  const entry = { ...event, seq: state.seq, ...(signer ? { keyId: signer.keyId } : {}) };
  const hash = chainHash(state.prev, entry);
  const line: Record<string, unknown> = { ...entry, prev: state.prev, hash };
  if (signer) line.sig = signer.sign(hash);
  state.prev = hash;
  state.seq += 1;
  return line;
}

export interface VerifyOptions {
  /** PEM/SPKI public keys by keyId. When an entry carries a `keyId`, its `sig`
   *  is verified against the matching key; a missing key is reported, not fatal. */
  publicKeys?: Record<string, string>;
}

export interface VerifyResult {
  ok: boolean;
  /** Total non-blank lines examined. */
  total: number;
  /** Count of leading lines with NO `hash` (legacy, pre-chain) — unprotected but
   *  not evidence of tampering. */
  unprotectedPrefix: number;
  /** Count of chained entries whose hash + linkage verified. */
  verified: number;
  /** Count of entries whose `sig` verified against a known public key. */
  signaturesVerified: number;
  /** First failing line (1-based) and why, when `ok` is false. */
  brokenAt?: number;
  reason?: string;
}

/** Recompute the chain over a persisted audit file and report the first break.
 *  Detects: edited fields (hash mismatch), reordering / deleted middle lines
 *  (prev linkage break), truncation from the end (only if an external anchor is
 *  known — see note), and forged entries when signing is in use (bad `sig`). */
export function verifyAuditChain(file: string, opts: VerifyOptions = {}): VerifyResult {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: true, total: 0, unprotectedPrefix: 0, verified: 0, signaturesVerified: 0 };
  }
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  let unprotectedPrefix = 0;
  let verified = 0;
  let signaturesVerified = 0;
  let prev = "";
  let expectedSeq: number | undefined;
  let started = false;

  for (let i = 0; i < lines.length; i++) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      return { ok: false, total: lines.length, unprotectedPrefix, verified, signaturesVerified, brokenAt: i + 1, reason: "unparseable line" };
    }
    const { entry, prev: linePrev, hash, sig } = splitChain(parsed);

    if (hash === undefined) {
      if (started) {
        // A chained region can't sprout an unchained hole in the middle.
        return { ok: false, total: lines.length, unprotectedPrefix, verified, signaturesVerified, brokenAt: i + 1, reason: "unchained line inside chained region" };
      }
      unprotectedPrefix += 1;
      continue;
    }

    started = true;
    if (linePrev !== prev) {
      return { ok: false, total: lines.length, unprotectedPrefix, verified, signaturesVerified, brokenAt: i + 1, reason: "prev-hash linkage broken (reordered or deleted entry)" };
    }
    const recomputed = chainHash(prev, entry);
    if (recomputed !== hash) {
      return { ok: false, total: lines.length, unprotectedPrefix, verified, signaturesVerified, brokenAt: i + 1, reason: "hash mismatch (entry was edited)" };
    }
    const seq = typeof entry.seq === "number" ? entry.seq : undefined;
    if (expectedSeq !== undefined && seq !== expectedSeq) {
      return { ok: false, total: lines.length, unprotectedPrefix, verified, signaturesVerified, brokenAt: i + 1, reason: "seq gap (entry inserted or removed)" };
    }
    expectedSeq = (seq ?? 0) + 1;

    if (sig !== undefined) {
      const keyId = typeof entry.keyId === "string" ? entry.keyId : undefined;
      const pub = keyId ? opts.publicKeys?.[keyId] : undefined;
      if (pub) {
        const good = crypto.verify(null, Buffer.from(hash, "hex"), pub, Buffer.from(sig, "base64"));
        if (!good) {
          return { ok: false, total: lines.length, unprotectedPrefix, verified, signaturesVerified, brokenAt: i + 1, reason: "signature invalid (forged entry)" };
        }
        signaturesVerified += 1;
      }
    }
    prev = hash;
    verified += 1;
  }

  return { ok: true, total: lines.length, unprotectedPrefix, verified, signaturesVerified };
}

// --- Node-side Ed25519 audit key -------------------------------------------
// A per-node signing key persisted next to the audit trail. Kept here (not in
// the kernel) so `bivy audit --verify` and the writer share one implementation.

export interface AuditKeypair {
  keyId: string;
  /** SPKI public key in PEM, safe to publish for verification. */
  publicKeyPem: string;
  signer: AuditSigner;
}

function fingerprint(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16);
}

/** Load (or mint, first run) the node's Ed25519 audit key under `dir`. The
 *  private key is written 0600; the public key + id are returned for anchoring
 *  in receipts and for the verifier's `publicKeys` map. */
export function loadOrCreateAuditKey(dir: string): AuditKeypair {
  const privPath = path.join(dir, "audit-key.pem");
  const pubPath = path.join(dir, "audit-key.pub.pem");
  let privateKeyPem: string;
  let publicKeyPem: string;
  try {
    privateKeyPem = fs.readFileSync(privPath, "utf8");
    publicKeyPem = fs.readFileSync(pubPath, "utf8");
  } catch {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(privPath, privateKeyPem, { mode: 0o600 });
    fs.writeFileSync(pubPath, publicKeyPem, { mode: 0o644 });
  }
  const keyId = fingerprint(publicKeyPem);
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  return {
    keyId,
    publicKeyPem,
    signer: {
      keyId,
      sign(hashHex: string): string {
        return crypto.sign(null, Buffer.from(hashHex, "hex"), privateKey).toString("base64");
      },
    },
  };
}
