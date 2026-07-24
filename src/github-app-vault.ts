// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { seal, open } from "./e2e.js";

/**
 * GitHub App private-key vault sync (issue #88): opt-in, E2E-encrypted delivery
 * of a connected GitHub App's private key from the node that holds it to the
 * account's OTHER enrolled nodes, riding the same wrap-key mechanism already
 * used for `model-auth-vault` (see src/pairing-crypto.ts, src/device-registry.ts).
 *
 * This module holds the parts that don't need a network round-trip: the
 * envelope format sealed under a per-app symmetric vault key, and the local
 * cache of resolved vault keys (one per app, since apps sync independently —
 * a node opted into sync only has the vault keys for apps it actually holds or
 * has pulled). The network glue (fetching/pushing against the control plane,
 * answering key requests) lives in src/server.ts next to its `model-auth-vault`
 * counterpart, which follows the same shape.
 *
 * The control plane only ever sees: ciphertext, and the vault key itself
 * wrapped per-recipient-node under an ECDH key it cannot derive. It never sees
 * a plaintext private key, matching the guarantee described in
 * src/github-apps.ts and docs/credential-sync.md.
 */

const ENVELOPE_VERSION = 1;

export interface GitHubAppVaultEnvelope {
  v: number;
  appId: string;
  privateKeyPem: string;
  slug?: string;
  name?: string;
  owner?: string;
  ownerType?: "User" | "Organization";
  hookId?: string;
}

/** Seal one app's private key (+ non-secret display metadata) for the vault. */
export function encryptGithubAppEnvelope(envelope: Omit<GitHubAppVaultEnvelope, "v">, vaultKeyB64: string): string {
  const payload: GitHubAppVaultEnvelope = { v: ENVELOPE_VERSION, ...envelope };
  return seal(Buffer.from(vaultKeyB64, "base64"), JSON.stringify(payload));
}

/** Open a sealed envelope. Throws if the key is wrong/stale or the payload is malformed. */
export function decryptGithubAppEnvelope(ciphertext: string, vaultKeyB64: string): GitHubAppVaultEnvelope {
  const parsed = JSON.parse(open(Buffer.from(vaultKeyB64, "base64"), ciphertext)) as Partial<GitHubAppVaultEnvelope>;
  if (!parsed || typeof parsed !== "object" || typeof parsed.appId !== "string" || typeof parsed.privateKeyPem !== "string" || !parsed.appId || !parsed.privateKeyPem) {
    throw new Error("Malformed GitHub App vault envelope");
  }
  return {
    v: typeof parsed.v === "number" ? parsed.v : ENVELOPE_VERSION,
    appId: parsed.appId,
    privateKeyPem: parsed.privateKeyPem,
    slug: typeof parsed.slug === "string" ? parsed.slug : undefined,
    name: typeof parsed.name === "string" ? parsed.name : undefined,
    owner: typeof parsed.owner === "string" ? parsed.owner : undefined,
    ownerType: parsed.ownerType === "Organization" || parsed.ownerType === "User" ? parsed.ownerType : undefined,
    hookId: typeof parsed.hookId === "string" ? parsed.hookId : undefined,
  };
}

// --- Local cache of resolved per-app vault keys -----------------------------
// One JSON file, `<dataDir>/github-app-vault.json` (0600), keyed by appId — NOT
// the same file as model-auth-vault's: a different credential class with an
// independent rotation lifecycle (docs/credential-sync.md), so wiping/rotating
// one must never touch the other.

interface LocalVaultKeyEntry {
  vaultKeyB64: string;
  createdAt: string;
}
type LocalVaultKeys = Record<string, LocalVaultKeyEntry>;

function vaultKeyFilePath(dataDir: string): string {
  return path.join(dataDir, "github-app-vault.json");
}

function readLocalVaultKeys(dataDir: string): LocalVaultKeys {
  try {
    const parsed = JSON.parse(fs.readFileSync(vaultKeyFilePath(dataDir), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as LocalVaultKeys) : {};
  } catch {
    return {};
  }
}

function writeLocalVaultKeys(dataDir: string, keys: LocalVaultKeys): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = vaultKeyFilePath(dataDir);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best effort on platforms without chmod
  }
  fs.renameSync(tmp, target);
}

/** The cached vault key for `appId`, if this node has resolved one. */
export function readLocalGithubAppVaultKey(dataDir: string, appId: string): string | undefined {
  const entry = readLocalVaultKeys(dataDir)[appId];
  if (!entry?.vaultKeyB64) return undefined;
  return Buffer.from(entry.vaultKeyB64, "base64").length === 32 ? entry.vaultKeyB64 : undefined;
}

export function writeLocalGithubAppVaultKey(dataDir: string, appId: string, vaultKeyB64: string): void {
  const keys = readLocalVaultKeys(dataDir);
  keys[appId] = { vaultKeyB64, createdAt: new Date().toISOString() };
  writeLocalVaultKeys(dataDir, keys);
}

/** Drop a stale cached key (e.g. it no longer decrypts the current ciphertext
 *  because the app was rotated) so the node re-requests a fresh wrap. */
export function forgetLocalGithubAppVaultKey(dataDir: string, appId: string): void {
  const keys = readLocalVaultKeys(dataDir);
  if (!(appId in keys)) return;
  delete keys[appId];
  writeLocalVaultKeys(dataDir, keys);
}

/**
 * Mint a brand-new local vault key for `appId`, OVERWRITING any cached one.
 * Used both the first time this node pushes the app, and to actually rotate:
 * a node that was removed from the account keeps whatever vault key it last
 * cached, so the only way to make that stale copy stop working is for a
 * surviving node to start encrypting under a key the removed node never saw.
 */
export function mintLocalGithubAppVaultKey(dataDir: string, appId: string): string {
  const vaultKeyB64 = randomBytes(32).toString("base64");
  writeLocalGithubAppVaultKey(dataDir, appId, vaultKeyB64);
  return vaultKeyB64;
}
