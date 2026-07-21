// SPDX-License-Identifier: FSL-1.1-ALv2
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

/** Stored api-key credential. `env` holds provider-scoped config (base URLs, ids). */
export interface ApiKeyCredential {
  type: "api_key";
  key?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
}

/** Stored OAuth credential. `expires` is epoch ms. */
export interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

/** One type-tagged credential per provider — Bivy's canonical shape. */
export type StoredCredential = ApiKeyCredential | OAuthCredential;

/** Non-secret metadata for enumeration (never exposes key/token material). */
export interface StoredCredentialInfo {
  providerId: string;
  type: StoredCredential["type"];
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
    return this.readBlob()[id];
  }

  async list(): Promise<readonly StoredCredentialInfo[]> {
    return Object.entries(this.readBlob()).map(([id, cred]) => ({ providerId: id, type: cred.type }));
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
    const id = providerId(provider);
    if (!id) throw new Error("Provider is required");
    return this.enqueue(id, async () => {
      await this.acquireLock();
      try {
        const vault = this.readBlob();
        const next = await fn(vault[id]);
        if (next === undefined) return vault[id];
        if (!isStoredCredential(next)) throw new Error(`Invalid credential for "${id}"`);
        vault[id] = next;
        this.writeBlob(vault);
        return next;
      } finally {
        await this.releaseLock();
      }
    });
  }

  async delete(provider: string): Promise<void> {
    const id = providerId(provider);
    if (!id) return;
    await this.enqueue(id, async () => {
      await this.acquireLock();
      try {
        const vault = this.readBlob();
        if (!(id in vault)) return;
        delete vault[id];
        this.writeBlob(vault);
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

  /** Every stored credential, keyed by provider id — the cross-node snapshot. */
  async exportAll(): Promise<Record<string, StoredCredential>> {
    return this.readBlob();
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
    const vault = this.readBlob();
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
  async importAll(snapshot: Record<string, unknown>): Promise<number> {
    await this.acquireLock();
    try {
      const vault = this.readBlob();
      let imported = 0;
      let changed = false;
      for (const [rawId, incoming] of Object.entries(snapshot ?? {})) {
        const id = providerId(rawId);
        if (!id || !isStoredCredential(incoming)) continue;
        const local = vault[id];
        if (incoming.type === "oauth" && local?.type === "oauth") {
          const localExpires = Number(local.expires) || 0;
          const incomingExpires = Number(incoming.expires) || 0;
          if (localExpires > incomingExpires) continue;
        }
        if (!(id in vault)) imported += 1;
        // Only mark dirty on a real content change, so a snapshot that merely
        // re-states what we already hold doesn't rewrite (and re-encrypt) the
        // vault — which would needlessly bump auth.enc's mtime and re-fire the
        // vault watcher (materialize → ingest → import loop protection).
        if (JSON.stringify(local) !== JSON.stringify(incoming)) {
          vault[id] = incoming;
          changed = true;
        }
      }
      if (changed) this.writeBlob(vault);
      return imported;
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

  private readBlob(): Record<string, StoredCredential> {
    this.ensureMigrated();
    let raw: string;
    try {
      raw = fs.readFileSync(this.blobFile, "utf8");
    } catch {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(open(this.key(), raw.trim()));
    } catch {
      // A truncated/corrupt/undecryptable vault is treated as empty rather than
      // taking the node down: every caller already handles "no credential".
      return {};
    }
    return normalizeMap(parsed);
  }

  private writeBlob(vault: Record<string, StoredCredential>): void {
    fs.mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 });
    const ciphertext = seal(this.key(), JSON.stringify(vault));
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
    const map = normalizeMap(legacy);
    if (Object.keys(map).length === 0) return;
    try {
      this.writeBlob(map);
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
