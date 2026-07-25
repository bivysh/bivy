// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { execFile } from "node:child_process";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type SecretBackend = "local" | "env" | "1password";

export type SecretRecord = {
  id: string;
  backend: SecretBackend;
  createdAt: string;
  updatedAt: string;
  description?: string;
  ref?: string;
  iv?: string;
  tag?: string;
  ciphertext?: string;
};

export type SecretPublicRecord = Omit<SecretRecord, "ciphertext" | "tag"> & { configured: boolean };

type SecretFile = { version: 1; records: Record<string, SecretRecord> };

function nowIso() { return new Date().toISOString(); }
function empty(): SecretFile { return { version: 1, records: {} }; }

// The vault's LAST-RESORT default (used only by `new SecretVault()` with no
// appDir — every daemon path passes an explicit one). Deliberately the home dir,
// NOT the daemon's <install>/.bivy: the vault refuses to mint a master key inside
// a git working tree, and <install>/.bivy is inside the repo in a dev checkout.
export function defaultSecretsDir(appDir?: string) {
  if (appDir) return appDir;
  return process.env.BIVY_DATA_DIR || path.join(os.homedir(), ".bivy");
}

/** True if `dir`, or any of its parents, is a git working tree (has a `.git` entry). */
function isInsideGitWorkTree(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function normalizeSecretId(id: string): string {
  const value = String(id || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}$/.test(value)) {
    throw new Error("Secret id must be 1-128 chars: letters, numbers, dot, dash, underscore, colon, slash, or @.");
  }
  return value;
}

function fileMode(file: string, mode: number) {
  try { fs.chmodSync(file, mode); } catch {}
}

function readJson(file: string): SecretFile {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    // Only a missing file means "nothing stored yet". Any other read failure
    // (permission denied, I/O error, etc.) must not be treated as empty.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return empty();
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SecretFile>;
    return { version: 1, records: parsed.records && typeof parsed.records === "object" ? parsed.records as Record<string, SecretRecord> : {} };
  } catch {
    // The file exists but is corrupt/truncated. Overwriting it with an empty
    // record set would silently discard every stored secret reference, so
    // fail loudly instead and let the caller decide how to recover.
    throw new Error(
      `Secrets file at ${file} is corrupt and could not be parsed. Refusing to reset it to empty. ` +
        `Restore it from a backup, or remove the file manually if you intend to start fresh.`,
    );
  }
}

function writeJson(file: string, data: SecretFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fileMode(tmp, 0o600);
  fs.renameSync(tmp, file);
  fileMode(file, 0o600);
}

export class SecretVault {
  readonly dir: string;
  readonly file: string;
  readonly keyFile: string;
  private data: SecretFile;

  constructor(appDir = defaultSecretsDir()) {
    this.dir = appDir;
    this.file = path.join(appDir, "secrets.json");
    this.keyFile = path.join(appDir, "secrets.key");
    this.data = readJson(this.file);
  }

  reload() { this.data = readJson(this.file); }

  list(): SecretPublicRecord[] {
    this.reload();
    return Object.values(this.data.records)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ ciphertext: _ciphertext, tag: _tag, ...record }) => ({ ...record, configured: true }));
  }

  getRecord(id: string): SecretRecord | undefined {
    this.reload();
    return this.data.records[normalizeSecretId(id)];
  }

  async resolve(idOrRef: string): Promise<string | undefined> {
    const value = String(idOrRef || "").trim();
    if (!value) return undefined;
    if (value.startsWith("secret://")) return this.resolve(value.slice("secret://".length));
    if (value.startsWith("env://")) return process.env[value.slice("env://".length)] || undefined;
    if (value.startsWith("op://")) return readOnePassword(value);

    const record = this.getRecord(value);
    if (!record) return undefined;
    if (record.backend === "env") return record.ref ? process.env[record.ref.replace(/^env:\/\//, "")] || undefined : undefined;
    if (record.backend === "1password") return record.ref ? readOnePassword(record.ref) : undefined;
    if (record.backend === "local") return this.decryptRecord(record);
    return undefined;
  }

  setReference(id: string, ref: string, description?: string) {
    const normalized = normalizeSecretId(id);
    const trimmed = String(ref || "").trim();
    let backend: SecretBackend;
    if (trimmed.startsWith("op://")) backend = "1password";
    else if (trimmed.startsWith("env://")) backend = "env";
    else throw new Error("Secret references must start with op:// or env://");
    const prev = this.data.records[normalized];
    const at = nowIso();
    this.data.records[normalized] = {
      id: normalized,
      backend,
      ref: trimmed,
      description: description ?? prev?.description,
      createdAt: prev?.createdAt ?? at,
      updatedAt: at,
    };
    writeJson(this.file, this.data);
  }

  setLocal(id: string, plaintext: string, description?: string) {
    const normalized = normalizeSecretId(id);
    const value = String(plaintext || "");
    if (!value) throw new Error("Secret value cannot be empty.");
    const prev = this.data.records[normalized];
    const at = nowIso();
    const encrypted = this.encrypt(value);
    this.data.records[normalized] = {
      id: normalized,
      backend: "local",
      description: description ?? prev?.description,
      createdAt: prev?.createdAt ?? at,
      updatedAt: at,
      ...encrypted,
    };
    writeJson(this.file, this.data);
  }

  set(id: string, valueOrRef: string, description?: string) {
    const value = String(valueOrRef || "").trim();
    if (value.startsWith("op://") || value.startsWith("env://")) this.setReference(id, value, description);
    else this.setLocal(id, valueOrRef, description);
  }

  delete(id: string): boolean {
    const normalized = normalizeSecretId(id);
    const had = Boolean(this.data.records[normalized]);
    if (had) {
      delete this.data.records[normalized];
      writeJson(this.file, this.data);
    }
    return had;
  }

  async doctor(): Promise<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }> {
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const dirExists = fs.existsSync(this.dir);
    checks.push({ name: "secrets directory", ok: dirExists, detail: this.dir });
    if (fs.existsSync(this.file)) checks.push({ name: "secrets file permissions", ok: modeIsPrivate(this.file), detail: this.file });
    if (fs.existsSync(this.keyFile)) checks.push({ name: "local key file permissions", ok: modeIsPrivate(this.keyFile), detail: this.keyFile });
    checks.push({ name: "1Password CLI", ok: await commandExists("op"), detail: "required for op:// references" });
    checks.push({ name: "GitHub CLI", ok: await commandExists("gh"), detail: "fallback for GitHub tokens when no Bivy secret is configured" });
    return { ok: checks.every((c) => c.ok || c.name === "1Password CLI" || c.name === "GitHub CLI"), checks };
  }

  private key(): Buffer {
    try {
      const raw = fs.readFileSync(this.keyFile, "utf8").trim();
      const key = Buffer.from(raw, "base64");
      if (key.length === 32) return key;
      // File exists but is malformed/truncated — surface it rather than silently
      // minting a new key that makes every stored secret undecryptable.
      throw new Error(`Local secrets key at ${this.keyFile} is invalid (expected 32 bytes)`);
    } catch (error) {
      // Only mint a fresh key when the file genuinely does not exist. A transient
      // read failure (EMFILE, permission blip) must NOT regenerate the key.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    if (isInsideGitWorkTree(this.dir)) {
      throw new Error(
        `Refusing to create the local secrets master key inside a git working tree (${this.dir}). ` +
          `Point BIVY_DATA_DIR (or the vault's appDir) somewhere outside of any git repository — ` +
          `e.g. ${path.join(os.homedir(), ".bivy")}.`,
      );
    }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    fs.writeFileSync(this.keyFile, `${key.toString("base64")}\n`, { mode: 0o600 });
    fileMode(this.keyFile, 0o600);
    return key;
  }

  private encrypt(plaintext: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv: iv.toString("base64"), tag: tag.toString("base64"), ciphertext: ciphertext.toString("base64") };
  }

  private decryptRecord(record: SecretRecord): string | undefined {
    if (!record.iv || !record.tag || !record.ciphertext) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(record.iv, "base64"));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }
}

async function commandExists(command: string): Promise<boolean> {
  const which = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  try { await exec(which, args, process.platform === "win32" ? {} : { shell: true } as any); return true; } catch { return false; }
}

async function readOnePassword(ref: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("op", ["read", ref], { env: process.env });
    return stdout.trim() || undefined;
  } catch (error) {
    throw new Error(`Could not read ${ref} with 1Password CLI. Run 'op signin' and check the reference.`);
  }
}

function modeIsPrivate(file: string): boolean {
  if (os.platform() === "win32") return true;
  try {
    const mode = fs.statSync(file).mode & 0o777;
    return (mode & 0o077) === 0;
  } catch {
    return false;
  }
}

export async function resolveSecret(value: string, appDir?: string): Promise<string | undefined> {
  return new SecretVault(appDir).resolve(value);
}
