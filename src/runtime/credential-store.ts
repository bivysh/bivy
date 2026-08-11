// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Bivy's app-owned credential store — the source of truth for model credentials.
//
// This module is deliberately PI-FREE (no import from any @earendil-works
// package, not even a type). Bivy owns the storage, the credential shape, the
// encryption, and the locking. Pi consumes this store as just another agent
// (see pi-oauth.ts, which adapts it to pi-ai's structurally-identical
// CredentialStore interface for injection into ModelRuntime).
//
// At rest the vault is encrypted (AES-256-GCM via the repo's own seal/open — no
// third crypto implementation) under a 0600 key minted once. Writes are
// serialized twice over: an in-process per-provider promise chain, and a
// cross-process mkdir lock (the `bivy login` CLI writes the same file as the
// running daemon). `modify()` is the only write path, so every mutation is a
// read-modify-write under the lock — the ordering OAuth refresh depends on
// (rotated refresh tokens are single-use; a read-then-write loses that race).

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { seal, open } from "../e2e.js";
import {
  migrateToV3,
  mergeDocuments,
  recordFromStored,
  emptyDocument,
  type CredentialVaultDocumentV3,
} from "../credentials/document.js";
import { credKey, parseCredKey, normalizeLabel, DEFAULT_LABEL, type CredentialRecord } from "../credentials/records.js";

/** Stored api-key credential. `env` holds provider-scoped config (base URLs, ids). */
export interface ApiKeyCredential {
  type: "api_key";
  key?: string;
  env?: Record<string, string>;
  /** Store-owned mutation time used to order cross-node updates and revocations. */
  updatedAt?: number;
  [key: string]: unknown;
}

/** Stored OAuth credential. `expires` is epoch ms. */
export interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  /**
   * Wall-clock epoch ms this token set was minted/refreshed on the node that
   * obtained it (see model-oauth `tokensFrom`). Used as the monotonic tiebreak in
   * `preferIncomingCredential` so cross-node merge follows mint order rather than
   * the access-token `expires` alone — which a fast/slow clock can inflate,
   * pinning the account onto a stale token. Optional: credentials minted before
   * this field existed fall back to the `expires` comparison.
   */
  refreshedAt?: number;
  /** Store-owned mutation time used to order cross-node updates and revocations. */
  updatedAt?: number;
  [key: string]: unknown;
}

/** One type-tagged credential per provider — Bivy's canonical shape. */
export type StoredCredential = ApiKeyCredential | OAuthCredential;

export type CredentialTombstones = Record<string, number>;

// The on-disk document is now v3 (a `provider:label`-keyed record map). The store
// migrates any prior encoding on read and persists v3, while its public surface
// keeps exchanging today's provider-keyed `StoredCredential` shapes via the
// `provider:default` record (multi-label storage is enabled but not yet exposed).
type CredentialVaultDocument = CredentialVaultDocumentV3;

/** Non-secret metadata for enumeration (never exposes key/token material). */
export interface StoredCredentialInfo {
  providerId: string;
  type: StoredCredential["type"];
  /** Epoch ms the OAuth access token expires, when `type === "oauth"`. */
  expiresAt?: number;
}

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isStoredCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "api_key" || type === "oauth";
}

/** Normalize a provider id the way every path expects (trimmed, lowercased). */
function providerId(id: string): string {
  return String(id ?? "").trim().toLowerCase();
}

function withoutStoreMetadata(credential: StoredCredential): StoredCredential {
  const { updatedAt: _updatedAt, ...projected } = credential;
  return projected as StoredCredential;
}

/** The `StoredCredential` inside a record, when it holds one (not a reference). */
function storedOf(record: CredentialRecord | undefined): StoredCredential | undefined {
  if (!record || record.source.kind !== "stored") return undefined;
  return record.source.cred;
}

/** The natural key for a provider's default credential — the v2-compatible slot. */
function defaultKey(provider: string): string {
  return credKey(providerId(provider), DEFAULT_LABEL);
}

/**
 * Should an `incoming` credential replace the `local` one during a non-destructive
 * `importAll` merge? Pure and exported so the convergence rule is unit-testable
 * without a vault. Rules:
 *  - No local entry → take the incoming one.
 *  - Only OAuth-vs-OAuth needs freshness arbitration (an api-key set/replace, or a
 *    type switch, keeps the existing "incoming wins on a real content change").
 *  - A snapshot that omits the refresh token must never clobber a usable one —
 *    rotated refresh tokens are single-use, so an incoming with a blank refresh is
 *    strictly worse than a local one that still has it.
 *  - Prefer the token minted LATER by `refreshedAt` (monotonic mint order) when
 *    both carry it; otherwise fall back to the access-token `expires`. In both
 *    cases a tie KEEPS the local credential (strictly-greater wins), so an equal
 *    stamp can't needlessly churn/rotate the vault, and clock skew can't let an
 *    equal-`expires` stale token win.
 */
export function preferIncomingCredential(local: StoredCredential | undefined, incoming: StoredCredential): boolean {
  if (!local) return true;
  if (local.type !== "oauth" || incoming.type !== "oauth") return true;
  const localRefresh = String(local.refresh ?? "").trim();
  const incomingRefresh = String(incoming.refresh ?? "").trim();
  if (!incomingRefresh && localRefresh) return false;
  const lt = Number(local.refreshedAt);
  const it = Number(incoming.refreshedAt);
  if (Number.isFinite(lt) && Number.isFinite(it)) return it > lt;
  return (Number(incoming.expires) || 0) > (Number(local.expires) || 0);
}

/** A tombstone wins only when it is newer than the credential it would remove. */
export function tombstoneWins(credential: StoredCredential | undefined, deletedAt: number): boolean {
  if (!Number.isFinite(deletedAt) || deletedAt <= 0) return false;
  if (!credential) return true;
  const updatedAt = Number(credential.updatedAt);
  const refreshedAt = credential.type === "oauth" ? Number(credential.refreshedAt) : 0;
  const credentialTime = Number.isFinite(updatedAt) && updatedAt > 0
    ? updatedAt
    : Number.isFinite(refreshedAt) && refreshedAt > 0 ? refreshedAt : 0;
  return deletedAt > credentialTime;
}

/**
 * Encrypted, cross-process-locked credential vault backed by `<vaultDir>/auth.enc`.
 *
 * `vaultDir` is the node's shared, agent-neutral credential directory
 * (`.bivy/credentials`) — NOT any one agent's directory. The optional
 * `plaintextDir` is where the decrypted `auth.json` projection is written for an
 * agent whose native CLI/TUI reads a plaintext store (Pi's own dir); it defaults
 * to `vaultDir` for callers that never materialize plaintext.
 *
 * The public surface intentionally matches pi-ai's `CredentialStore`
 * (`read`/`list`/`modify`/`delete`) so pi-oauth.ts can inject it into a
 * `ModelRuntime` with a single structural cast — plus Bivy-owned `exportAll` /
 * `importAll` for cross-node sync. Nothing here depends on pi.
 */
export class BivyCredentialStore {
  private readonly blobFile: string;
  private readonly keyFile: string;
  private readonly legacyFile: string;
  private readonly lockDir: string;
  private readonly plaintextDir: string;
  private readonly chains = new Map<string, Promise<unknown>>();
  private migrated = false;

  constructor(private readonly vaultDir: string, plaintextDir?: string) {
    this.blobFile = path.join(vaultDir, "auth.enc");
    this.keyFile = path.join(vaultDir, "auth.key");
    this.lockDir = path.join(vaultDir, "auth.enc.lock");
    // The plaintext projection is an agent-specific concern (an agent whose CLI
    // reads its own `auth.json`), so it can live in a different dir than the
    // shared encrypted vault.
    this.plaintextDir = plaintextDir ?? vaultDir;
    this.legacyFile = path.join(this.plaintextDir, "auth.json");
  }

  // --- pi-ai CredentialStore surface ---------------------------------------

  async read(provider: string): Promise<StoredCredential | undefined> {
    const id = providerId(provider);
    if (!id) return undefined;
    const cred = storedOf(this.readDocument().credentials[defaultKey(id)]);
    return cred ? withoutStoreMetadata(cred) : undefined;
  }

  async list(): Promise<readonly StoredCredentialInfo[]> {
    const infos: StoredCredentialInfo[] = [];
    for (const record of Object.values(this.readDocument().credentials)) {
      const cred = storedOf(record);
      // A reference record holds no token here; it is api-key-shaped when resolved.
      const type: StoredCredential["type"] = cred ? cred.type : "api_key";
      infos.push({
        providerId: record.provider,
        type,
        ...(cred && cred.type === "oauth" ? { expiresAt: (cred as OAuthCredential).expires } : {}),
      });
    }
    return infos;
  }

  /**
   * Serialized read-modify-write — the only write path. `fn` sees the credential
   * as of this write (not as of when the caller decided to write), so a refresh
   * cannot be clobbered by a concurrent import. Returns the post-write
   * credential; `fn` returning undefined leaves the entry unchanged.
   */
  async modify(
    provider: string,
    fn: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>,
  ): Promise<StoredCredential | undefined> {
    return this.modifyRecord(provider, DEFAULT_LABEL, fn);
  }

  /**
   * Record-addressed read-modify-write over a specific `provider:label` slot —
   * `modify()` is the `label="default"` case. This is what makes OAuth refresh
   * safe with multiple accounts per provider: a refresh rotates the *selected*
   * record under its own lock, so refreshing `anthropic:work` can't clobber
   * `anthropic:personal` (rotated refresh tokens are single-use). `fn` operates on
   * the record's stored credential; the record's label/sync/origin are preserved.
   */
  async modifyRecord(
    provider: string,
    label: string,
    fn: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>,
  ): Promise<StoredCredential | undefined> {
    const id = providerId(provider);
    if (!id) throw new Error("Provider is required");
    const key = credKey(id, label);
    return this.enqueue(id, async () => {
      await this.acquireLock();
      try {
        const document = this.readDocument();
        const existing = document.credentials[key];
        const current = storedOf(existing);
        const next = await fn(current);
        if (next === undefined) return current;
        if (!isStoredCredential(next)) throw new Error(`Invalid credential for "${id}"`);
        const now = Date.now();
        // Store the credential clean; the store-owned stamp lives on the record.
        // Preserve the record's label/sync/origin when it already exists.
        const clean = withoutStoreMetadata(next);
        const record: CredentialRecord = existing
          ? { ...existing, source: { kind: "stored", cred: clean }, updatedAt: now }
          : { ...recordFromStored(id, clean), label: normalizeLabel(label), updatedAt: now };
        document.credentials[key] = record;
        delete document.deletedAt[key];
        this.writeDocument(document);
        // Preserve the historical return contract: the stored credential with its
        // fresh store-owned stamp.
        return { ...clean, updatedAt: now } as StoredCredential;
      } finally {
        await this.releaseLock();
      }
    });
  }

  async delete(provider: string): Promise<void> {
    const id = providerId(provider);
    if (!id) return;
    const key = defaultKey(id);
    await this.enqueue(id, async () => {
      await this.acquireLock();
      try {
        const document = this.readDocument();
        const hadCredential = key in document.credentials;
        delete document.credentials[key];
        const deletedAt = Date.now();
        if (!hadCredential && (document.deletedAt[key] ?? 0) >= deletedAt) return;
        document.deletedAt[key] = deletedAt;
        this.writeDocument(document);
      } finally {
        await this.releaseLock();
      }
    });
  }

  // --- Bivy-owned convenience ---------------------------------------------

  /** Store an API key (the common non-OAuth login). */
  async setApiKey(provider: string, key: string): Promise<void> {
    const apiKey = String(key ?? "").trim();
    if (!apiKey) throw new Error("API key cannot be empty");
    await this.modify(provider, async () => ({ type: "api_key", key: apiKey }));
  }

  /**
   * Store a reference credential — a pointer (`op://…` / `env://NAME` / `cmd://…`)
   * resolved per-node at read time (see the resolver), never the secret itself.
   * The pointer is safe to sync across nodes; the secret stays in the manager. A
   * reference is api-key-shaped, so it cannot model a rotating OAuth token set.
   *
   * `cmd://` references are forced NODE-LOCAL: they run a command, so syncing one
   * would be cross-node code execution (and the command is machine-specific
   * anyway). `exportSyncableRecords` additionally never emits them.
   * Writes at `provider:label` (defaulting to the provider's default slot).
   */
  async setReference(
    provider: string,
    ref: string,
    backend: "1password" | "env" | "command",
    label: string = DEFAULT_LABEL,
  ): Promise<void> {
    const id = providerId(provider);
    if (!id) throw new Error("Provider is required");
    const pointer = String(ref ?? "").trim();
    if (!pointer) throw new Error("Reference cannot be empty");
    const key = credKey(id, label);
    await this.enqueue(id, async () => {
      await this.acquireLock();
      try {
        const document = this.readDocument();
        const existing = document.credentials[key];
        const record: CredentialRecord = {
          provider: id,
          label: normalizeLabel(label),
          source: { kind: "reference", ref: pointer, backend },
          // A cmd:// reference is always node-local (never sync a command).
          // Otherwise preserve an existing record's sync/origin; a new reference
          // is a Bivy-first, opt-out-sync credential (only the pointer ever syncs).
          sync: backend === "command" ? "node" : existing?.sync ?? "account",
          origin: existing?.origin ?? "bivy",
          updatedAt: Date.now(),
        };
        document.credentials[key] = record;
        delete document.deletedAt[key];
        this.writeDocument(document);
      } finally {
        await this.releaseLock();
      }
    });
  }

  /**
   * Every stored credential, keyed by provider id — the cross-node snapshot.
   * The wire stays provider-keyed (v2 shape), so only `provider:default` records
   * are projected; the store-owned `updatedAt` is re-attached to the credential so
   * a peer's merge can order it. (Non-default labels are not yet synced — phase 6.)
   */
  async exportAll(): Promise<Record<string, StoredCredential>> {
    return this.projectDefaults(() => true);
  }

  /**
   * The cross-node sync snapshot: only `provider:default` credentials the user
   * has left on the account-sync tier (`sync: "account"`). A credential opted to
   * `sync: "node"` is kept local — this is the per-credential opt-out. Reference
   * records carry no syncable secret and are skipped either way. (Local reads that
   * must see every credential — e.g. `provider.auth.get` — use `exportAll`.)
   */
  async exportSyncable(): Promise<Record<string, StoredCredential>> {
    return this.projectDefaults((record) => record.sync === "account");
  }

  /** Shared projection of default-slot stored credentials to the provider-keyed wire. */
  private projectDefaults(include: (record: CredentialRecord) => boolean): Record<string, StoredCredential> {
    const out: Record<string, StoredCredential> = {};
    for (const record of Object.values(this.readDocument().credentials)) {
      if (record.label !== DEFAULT_LABEL || !include(record)) continue;
      const cred = storedOf(record);
      if (!cred) continue;
      out[record.provider] = record.updatedAt ? { ...cred, updatedAt: record.updatedAt } : cred;
    }
    return out;
  }

  /** Provider deletions retained for cross-node convergence (provider-keyed wire). */
  async exportTombstones(): Promise<CredentialTombstones> {
    const out: CredentialTombstones = {};
    for (const [key, stamp] of Object.entries(this.readDocument().deletedAt)) {
      const parsed = parseCredKey(key);
      if (!parsed) out[key] = stamp;
      else if (parsed.label === DEFAULT_LABEL) out[parsed.provider] = stamp;
    }
    return out;
  }

  /**
   * Every stored credential as a full v3 record (`provider:label`, source, sync,
   * origin). This is the multi-credential surface selection reads — it carries
   * secret material, so it is for trusted in-node callers (the credential
   * resolver), not enumeration. Use `list()` for non-secret metadata.
   */
  async listRecords(): Promise<readonly CredentialRecord[]> {
    return Object.values(this.readDocument().credentials);
  }

  /** Read one credential record by its `provider:label` identity. */
  async readRecord(provider: string, label: string = DEFAULT_LABEL): Promise<CredentialRecord | undefined> {
    const id = providerId(provider);
    if (!id) return undefined;
    return this.readDocument().credentials[credKey(id, label)];
  }

  /**
   * Authoritatively upsert a record at its `provider:label` — the record-addressed
   * write behind the multi-credential API (add/label a specific account). Stamps
   * the store-owned `updatedAt` and clears any tombstone for that slot. Use
   * `importRecords()` (merge) for ingest/sync, where a fresher local login must win.
   */
  async putRecord(record: CredentialRecord): Promise<void> {
    const id = providerId(record.provider);
    if (!id) throw new Error("Provider is required");
    const label = normalizeLabel(record.label);
    const key = credKey(id, label);
    await this.enqueue(id, async () => {
      await this.acquireLock();
      try {
        const document = this.readDocument();
        document.credentials[key] = { ...record, provider: id, label, updatedAt: Date.now() };
        delete document.deletedAt[key];
        this.writeDocument(document);
      } finally {
        await this.releaseLock();
      }
    });
  }

  /** Forget one record by `provider:label`, leaving a tombstone for convergence. */
  async deleteRecord(provider: string, label: string = DEFAULT_LABEL): Promise<void> {
    const id = providerId(provider);
    if (!id) return;
    const key = credKey(id, label);
    await this.enqueue(id, async () => {
      await this.acquireLock();
      try {
        const document = this.readDocument();
        const had = key in document.credentials;
        delete document.credentials[key];
        const deletedAt = Date.now();
        if (!had && (document.deletedAt[key] ?? 0) >= deletedAt) return;
        document.deletedAt[key] = deletedAt;
        this.writeDocument(document);
      } finally {
        await this.releaseLock();
      }
    });
  }

  /**
   * Merge record snapshots into the vault, record-addressed and non-destructive
   * (freshest-OAuth-wins, rotation-safe, tombstone-newer-wins — see document.ts).
   * This is the record-level counterpart to `importAll`, for agent-native ingest
   * under reserved labels and (later) record-shaped cross-node sync. Returns the
   * number of newly-added records.
   */
  async importRecords(
    records: readonly CredentialRecord[],
    deletedAt: Record<string, number> = {},
  ): Promise<number> {
    await this.acquireLock();
    try {
      const document = this.readDocument();
      const incoming: Record<string, CredentialRecord> = {};
      for (const record of records) incoming[credKey(record.provider, record.label)] = record;
      const result = mergeDocuments(document, incoming, deletedAt);
      if (result.changed) this.writeDocument(result.document);
      return result.imported;
    } finally {
      await this.releaseLock();
    }
  }

  /**
   * The record-shaped cross-node snapshot: every account-tier (`sync: "account"`)
   * record, keyed by `provider:label` — INCLUDING non-default labels and reference
   * records. A reference carries only its pointer (never a secret), so syncing it
   * lets each node resolve the same manager entry locally. This is the v3 sync
   * wire; `exportSyncable()` is the v2 provider-keyed projection kept for old peers.
   */
  async exportSyncableRecords(): Promise<Record<string, CredentialRecord>> {
    const out: Record<string, CredentialRecord> = {};
    for (const record of Object.values(this.readDocument().credentials)) {
      if (record.sync !== "account") continue;
      // A cmd:// reference is never synced — a command that runs on a peer is
      // cross-node code execution. Belt-and-suspenders with the node-local sync
      // default in setReference().
      if (record.source.kind === "reference" && record.source.backend === "command") continue;
      out[credKey(record.provider, record.label)] = record;
    }
    return out;
  }

  /** Record-keyed tombstones (all deletions) for record-shaped convergence. */
  async exportRecordTombstones(): Promise<CredentialTombstones> {
    return { ...this.readDocument().deletedAt };
  }

  /** The plaintext `auth.json` path an agent's own CLI/TUI reads (`<plaintextDir>/auth.json`). */
  get legacyAuthPath(): string {
    return this.legacyFile;
  }

  /**
   * Write the decrypted vault to `<plaintextDir>/auth.json` so a subprocess that
   * reads a plaintext store (e.g. Pi's own interactive TUI) can use the same
   * logins.
   * Synchronous, 0600. This is the bridge for the native-TUI hand-off; daemon
   * agents get credentials via env injection and never see this file. Pair with
   * `ingestPlaintext()` to fold TUI-time logins back into the vault.
   */
  materializePlaintext(): string {
    const vault: Record<string, StoredCredential> = {};
    for (const record of Object.values(this.readDocument().credentials)) {
      if (record.label !== DEFAULT_LABEL) continue;
      const cred = storedOf(record);
      if (cred) vault[record.provider] = withoutStoreMetadata(cred);
    }
    const next = `${JSON.stringify(vault, null, 2)}\n`;
    // Write only when the projection actually changes. This keeps the file's
    // mtime stable so a live re-materialize (on a vault change while a native Pi
    // TUI is running) can't ping-pong with the auth.json watcher's ingest.
    try {
      if (fs.readFileSync(this.legacyFile, "utf8") === next) return this.legacyFile;
    } catch { /* missing/unreadable — fall through and write */ }
    fs.mkdirSync(this.plaintextDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.legacyFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, next, { mode: 0o600 });
    fs.renameSync(tmp, this.legacyFile);
    try { fs.chmodSync(this.legacyFile, 0o600); } catch { /* best effort */ }
    return this.legacyFile;
  }

  /** Fold any credentials in the plaintext `auth.json` (e.g. a TUI login) back into the vault. */
  async ingestPlaintext(): Promise<number> {
    let legacy: unknown;
    try {
      legacy = JSON.parse(fs.readFileSync(this.legacyFile, "utf8"));
    } catch {
      return 0;
    }
    return this.importAll(normalizeMap(legacy));
  }

  /**
   * Merge an account snapshot into the vault. Merge, never destroy: a lagging
   * snapshot that omits a provider must not delete a fresh local login, and a
   * locally-fresher OAuth token must win over an older one in the snapshot
   * (rotated refresh tokens are single-use — importing a stale one breaks the
   * next refresh). Runs under the lock so it can't race a refresh.
   */
  async importAll(snapshot: Record<string, unknown>, deletedAt: Record<string, unknown> = {}): Promise<number> {
    await this.acquireLock();
    try {
      const document = this.readDocument();
      // The snapshot/tombstones arrive in the provider-keyed v2 wire shape (sync
      // envelope, ingest, plaintext auth.json). Migrate them to records under
      // `provider:default`, then apply the shared record-addressed convergence
      // engine (merge-never-destroy, freshest-OAuth-wins, rotation-safe,
      // tombstone-newer-wins — see document.ts).
      const incoming = migrateToV3({ v: 2, providers: snapshot, deletedAt });
      const result = mergeDocuments(document, incoming.credentials, incoming.deletedAt);
      if (result.changed) this.writeDocument(result.document);
      return result.imported;
    } finally {
      await this.releaseLock();
    }
  }

  // --- storage internals ---------------------------------------------------

  private key(): Buffer {
    try {
      const key = Buffer.from(fs.readFileSync(this.keyFile, "utf8").trim(), "base64");
      if (key.length === 32) return key;
      // Present but malformed — surface it rather than mint a new key that makes
      // every stored credential undecryptable.
      throw new Error(`Credential key at ${this.keyFile} is invalid (expected 32 bytes)`);
    } catch (error) {
      // Mint only when the key genuinely does not exist. A transient read
      // failure (EMFILE, permission blip) must NOT regenerate the key.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    fs.mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    fs.writeFileSync(this.keyFile, `${key.toString("base64")}\n`, { mode: 0o600 });
    try { fs.chmodSync(this.keyFile, 0o600); } catch { /* best effort */ }
    return key;
  }

  private readDocument(): CredentialVaultDocument {
    this.ensureMigrated();
    let raw: string;
    try {
      raw = fs.readFileSync(this.blobFile, "utf8");
    } catch {
      return emptyDocument();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(open(this.key(), raw.trim()));
    } catch {
      // A truncated/corrupt/undecryptable vault is treated as empty rather than
      // taking the node down: every caller already handles "no credential".
      return emptyDocument();
    }
    // migrateToV3 accepts a v3 document, a v2 `{ providers, deletedAt }` document,
    // or a bare v1 provider→StoredCredential map, and always yields a normalized v3
    // document — so an existing vault upgrades transparently on first read.
    return migrateToV3(parsed);
  }

  private writeDocument(document: CredentialVaultDocument): void {
    fs.mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 });
    const ciphertext = seal(this.key(), JSON.stringify(document));
    const tmp = `${this.blobFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${ciphertext}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.blobFile);
    try { fs.chmodSync(this.blobFile, 0o600); } catch { /* best effort */ }
  }

  /**
   * One-time, best-effort import of a legacy plaintext `auth.json` when the
   * encrypted vault does not exist yet. Dev convenience so an existing install
   * keeps its logins across the upgrade; non-destructive (auth.json is left in
   * place). Pre-users, so this is the only migration we owe.
   */
  private ensureMigrated(): void {
    if (this.migrated) return;
    this.migrated = true;
    if (fs.existsSync(this.blobFile)) return;
    let legacy: unknown;
    try {
      legacy = JSON.parse(fs.readFileSync(this.legacyFile, "utf8"));
    } catch {
      return; // no legacy file / unreadable — nothing to import
    }
    const document = migrateToV3(legacy);
    if (Object.keys(document.credentials).length === 0) return;
    try {
      this.writeDocument(document);
    } catch {
      // If we can't write the encrypted vault, fall back to reading legacy on
      // the next call rather than crashing.
      this.migrated = false;
    }
  }

  // --- locking -------------------------------------------------------------

  private enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(id) ?? Promise.resolve();
    // Chain off settlement, not value: one caller's rejection must not cancel
    // the next caller's write.
    const next = prior.then(task, task);
    this.chains.set(id, next.catch(() => undefined));
    return next;
  }

  private async acquireLock(): Promise<void> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        fs.mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 });
        fs.mkdirSync(this.lockDir);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (this.breakIfStale()) continue;
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for the credential lock at ${this.lockDir}`);
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
  }

  /** Remove a lock whose owner died mid-write. Returns true if it broke one. */
  private breakIfStale(): boolean {
    try {
      const age = Date.now() - fs.statSync(this.lockDir).mtimeMs;
      if (age < LOCK_STALE_MS) return false;
      fs.rmdirSync(this.lockDir);
      return true;
    } catch {
      // Lost the race to another breaker, or it was released under us — the next
      // mkdir attempt is the source of truth.
      return false;
    }
  }

  private async releaseLock(): Promise<void> {
    await fsp.rmdir(this.lockDir).catch(() => {});
  }
}

/** Coerce arbitrary parsed JSON into a `{ [id]: StoredCredential }` map. */
function normalizeMap(parsed: unknown): Record<string, StoredCredential> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, StoredCredential> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isStoredCredential(value)) out[providerId(id)] = value;
  }
  return out;
}

/**
 * Build the node's shared credential vault at `<vaultDir>/auth.enc`. Pass
 * `plaintextDir` when an agent's native CLI reads a plaintext `auth.json` in a
 * different directory (e.g. Pi's own dir); it defaults to `vaultDir`.
 */
export function createCredentialVault(vaultDir: string, plaintextDir?: string): BivyCredentialStore {
  return new BivyCredentialStore(vaultDir, plaintextDir);
}

/**
 * One-time, best-effort relocation of the encrypted vault (`auth.enc` +
 * `auth.key`) from a legacy directory to the node's dedicated credentials dir.
 * This is the migration for installs created before the vault was split out of an
 * agent's own directory — so an existing user keeps their logins across the
 * upgrade instead of re-authenticating.
 *
 * Idempotent: it only runs when the destination has no vault yet and the source
 * does. The key is moved before the ciphertext, so a crash mid-move leaves the
 * destination without an `auth.enc` (the guard re-runs the move next boot) rather
 * than an undecryptable one. The plaintext `auth.json` is intentionally NOT moved
 * — it stays in the agent's own dir, where its native CLI/TUI reads it.
 * Returns true if it moved a vault.
 */
export function migrateVaultDir(fromDir: string, toDir: string): boolean {
  if (fromDir === toDir) return false;
  try {
    // Guard: never overwrite a vault already in place at the destination, and do
    // nothing when there is no legacy vault to move.
    if (fs.existsSync(path.join(toDir, "auth.enc")) || !fs.existsSync(path.join(fromDir, "auth.enc"))) return false;
    fs.mkdirSync(toDir, { recursive: true, mode: 0o700 });
    // Move the key first, then the ciphertext (see doc-comment ordering rationale).
    for (const name of ["auth.key", "auth.enc"]) {
      const from = path.join(fromDir, name);
      const to = path.join(toDir, name);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      try {
        fs.renameSync(from, to);
      } catch {
        // Cross-device or transient failure — copy then unlink the source.
        fs.copyFileSync(from, to);
        try { fs.unlinkSync(from); } catch { /* leave the source; the guard stops a re-copy */ }
      }
      try { fs.chmodSync(to, 0o600); } catch { /* best effort */ }
    }
    return fs.existsSync(path.join(toDir, "auth.enc"));
  } catch {
    // Best-effort: a failed migration just means the user re-authenticates.
    return false;
  }
}
