// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Encryption at rest for hosted-provisioning credentials. Secrets are sealed
// with AES-256-GCM under per-account HKDF subkeys. The key source is selected at
// boot; callers remain independent of whether key bytes came from env or KMS.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const INFO = Buffer.from("bivy-hosted-provisioning-v1");
const LEGACY_KID = "default";

export interface Keyring {
  primaryKid: string;
  keys: Map<string, Buffer>;
}

/** Source of the in-memory master-key ring. A network-backed implementation
 * resolves its key material during initializeHostedKeyring(), before listen. */
export interface KeyringSource {
  load(): Keyring | null;
}

function decode32(b64: string): Buffer | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64.trim(), "base64");
  } catch {
    return null;
  }
  return buf.length === 32 ? buf : null;
}

/** Existing environment keyring behavior, deliberately kept per-call so env
 * rotation and tests have exactly the same parsing/availability semantics. */
export class EnvKeyringSource implements KeyringSource {
  load(): Keyring | null {
    const keys = new Map<string, Buffer>();
    let primaryKid = "";

    const multi = process.env.HOSTED_CREDENTIAL_KEYS;
    if (multi) {
      for (const part of multi.split(",")) {
        const idx = part.indexOf(":");
        if (idx <= 0) continue;
        const kid = part.slice(0, idx).trim();
        const key = decode32(part.slice(idx + 1));
        if (kid && key) keys.set(kid, key);
      }
      primaryKid = (process.env.HOSTED_CREDENTIAL_KEY_PRIMARY || [...keys.keys()][0] || "").trim();
    }

    const single = process.env.HOSTED_CREDENTIAL_KEY;
    if (single) {
      const key = decode32(single);
      if (key) {
        keys.set(LEGACY_KID, key);
        if (!primaryKid) primaryKid = LEGACY_KID;
      }
    }

    if (!keys.size || !primaryKid || !keys.has(primaryKid)) return null;
    return { primaryKid, keys };
  }
}

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsKmsDependencies {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function awsCredentials(): AwsCredentials | null {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim() ?? "";
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = process.env.AWS_SESSION_TOKEN?.trim() || process.env.AWS_SECURITY_TOKEN?.trim();
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Dependency-free SigV4 signer, ported from packages/core's awsSign rather
 * than importing the browser/core layer into the control plane. */
function signKmsRequest(
  host: string,
  region: string,
  body: string,
  creds: AwsCredentials,
  now: Date,
): Record<string, string> {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    host,
    "x-amz-date": amzDate,
    "x-amz-target": "TrentService.Decrypt",
  };
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256(body)].join("\n");
  const scope = `${dateStamp}/${region}/kms/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "kms");
  const signature = hmac(hmac(kService, "aws4_request"), stringToSign).toString("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function kmsCiphertexts(raw: string, fallbackKid: string): Array<{ kid: string; ciphertext: string }> {
  const parts = raw.split(",");
  if (parts.length === 1 && !parts[0].includes(":")) return [{ kid: fallbackKid, ciphertext: parts[0].trim() }];
  return parts.map((part) => {
    const idx = part.indexOf(":");
    if (idx <= 0) throw new Error("BIVY_HOSTED_KEY_KMS_CIPHERTEXT must be base64 or kid:base64 entries");
    return { kid: part.slice(0, idx).trim(), ciphertext: part.slice(idx + 1).trim() };
  });
}

/** AWS KMS source. KMS decrypts encrypted data-key blobs once at boot; request
 * paths use only the resulting in-memory keyring and never make network calls. */
export class AwsKmsKeyringSource implements KeyringSource {
  private keyring: Keyring | null = null;

  constructor(private readonly deps: AwsKmsDependencies = {}) {}

  load(): Keyring | null { return this.keyring; }

  async initialize(): Promise<void> {
    this.keyring = null;
    const region = process.env.BIVY_HOSTED_KEY_KMS_REGION?.trim() || process.env.AWS_REGION?.trim() || "";
    const raw = process.env.BIVY_HOSTED_KEY_KMS_CIPHERTEXT?.trim() ?? "";
    const keyId = process.env.BIVY_HOSTED_KEY_KMS_KEY_ID?.trim() ?? "";
    const creds = awsCredentials();
    if (!region || !/^[a-z0-9-]+$/.test(region)) throw new Error("BIVY_HOSTED_KEY_KMS_REGION (or AWS_REGION) is required");
    if (!raw) throw new Error("BIVY_HOSTED_KEY_KMS_CIPHERTEXT is required");
    if (!creds) throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required");

    const fallbackKid = process.env.HOSTED_CREDENTIAL_KEY_PRIMARY?.trim() || keyId || "kms";
    const entries = kmsCiphertexts(raw, fallbackKid);
    const primaryKid = process.env.HOSTED_CREDENTIAL_KEY_PRIMARY?.trim() || entries[0]?.kid || "";
    if (!entries.length || !primaryKid || !entries.some((entry) => entry.kid === primaryKid)) {
      throw new Error("HOSTED_CREDENTIAL_KEY_PRIMARY is not present in the KMS ciphertext keyring");
    }
    const host = `kms.${region}.${region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}`;
    const keys = new Map<string, Buffer>();
    for (const entry of entries) {
      if (!entry.kid || !entry.ciphertext) throw new Error("KMS ciphertext keyring contains an empty key id or blob");
      const body = JSON.stringify({ CiphertextBlob: entry.ciphertext, ...(keyId ? { KeyId: keyId } : {}) });
      const headers = signKmsRequest(host, region, body, creds, (this.deps.now ?? (() => new Date()))());
      const response = await (this.deps.fetchImpl ?? fetch)(`https://${host}/`, { method: "POST", headers, body });
      const result = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        const detail = typeof result.message === "string" ? result.message : `HTTP ${response.status}`;
        throw new Error(`AWS KMS Decrypt failed for '${entry.kid}': ${detail}`);
      }
      const plaintext = typeof result.Plaintext === "string" ? decode32(result.Plaintext) : null;
      if (!plaintext) throw new Error(`AWS KMS returned an invalid data key for '${entry.kid}' (expected 32 bytes)`);
      keys.set(entry.kid, plaintext);
    }
    this.keyring = { primaryKid, keys };
  }
}

const envKeyringSource = new EnvKeyringSource();
let configuredSource: KeyringSource = envKeyringSource;

/** Select and initialize the configured source. KMS errors intentionally leave
 * an unavailable KMS source installed: there is no fallback to env key bytes. */
export async function initializeHostedKeyring(deps: AwsKmsDependencies = {}): Promise<void> {
  const selected = (process.env.HOSTED_KEYRING_SOURCE?.trim().toLowerCase() || "env");
  if (selected === "env") {
    configuredSource = envKeyringSource;
    return;
  }
  if (selected !== "aws-kms") {
    configuredSource = { load: () => null };
    console.error(`[hosted-keyring] unavailable: unknown HOSTED_KEYRING_SOURCE '${selected}' (expected env or aws-kms)`);
    return;
  }
  const source = new AwsKmsKeyringSource(deps);
  configuredSource = source;
  try {
    await source.initialize();
    console.log(`[hosted-keyring] loaded AWS KMS keyring (primary kid ${source.load()?.primaryKid})`);
  } catch (error) {
    console.error(`[hosted-keyring] AWS KMS source unavailable; hosted credentials fail closed: ${(error as Error).message}`);
  }
}

export function setKeyringSource(source: KeyringSource | null): void {
  configuredSource = source ?? envKeyringSource;
}

function loadKeyring(): Keyring | null { return configuredSource.load(); }

function requireKeyring(): Keyring {
  const keyring = loadKeyring();
  if (!keyring) throw new Error("No hosted credential key configured (HOSTED_CREDENTIAL_KEY[S]) — refusing to handle hosted credentials");
  return keyring;
}

/** Hosted-key boundary retained for callers that use an async provider API. */
export interface HostedKeyProvider {
  available(): Promise<boolean>;
  primaryKeyId(): Promise<string | null>;
  encrypt(accountId: string, plaintext: string): Promise<SecretEnvelope>;
  decrypt(accountId: string, envelope: SecretEnvelope): Promise<string>;
}

let configuredProvider: HostedKeyProvider | null = null;
export function setHostedKeyProvider(provider: HostedKeyProvider | null): void { configuredProvider = provider; }
export function hostedKeyProvider(): HostedKeyProvider { return configuredProvider ?? environmentHostedKeyProvider; }

export const environmentHostedKeyProvider: HostedKeyProvider = {
  available: async () => hostedEncryptionAvailable(),
  primaryKeyId: async () => hostedPrimaryKid(),
  encrypt: async (accountId, plaintext) => encryptSecret(accountId, plaintext),
  decrypt: async (accountId, envelope) => decryptSecret(accountId, envelope),
};

export const encryptHostedSecret = (accountId: string, plaintext: string) => hostedKeyProvider().encrypt(accountId, plaintext);
export const decryptHostedSecret = (accountId: string, envelope: SecretEnvelope) => hostedKeyProvider().decrypt(accountId, envelope);

export function hostedEncryptionAvailable(): boolean { return loadKeyring() != null; }
export function hostedPrimaryKid(): string | null { return loadKeyring()?.primaryKid ?? null; }

function accountKey(master: Buffer, accountId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.from(accountId, "utf8"), INFO, 32));
}

export interface SecretEnvelope {
  v: 1;
  kid?: string;
  iv: string;
  ct: string;
  tag: string;
}

export function isSecretEnvelope(v: unknown): v is SecretEnvelope {
  return !!v && typeof v === "object" && (v as { v?: unknown }).v === 1
    && typeof (v as SecretEnvelope).iv === "string"
    && typeof (v as SecretEnvelope).ct === "string"
    && typeof (v as SecretEnvelope).tag === "string";
}

export function encryptSecret(accountId: string, plaintext: string): SecretEnvelope {
  const keyring = requireKeyring();
  const key = accountKey(keyring.keys.get(keyring.primaryKid)!, accountId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, kid: keyring.primaryKid, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: tag.toString("base64") };
}

export function decryptSecret(accountId: string, env: SecretEnvelope): string {
  const keyring = requireKeyring();
  const kid = env.kid ?? LEGACY_KID;
  const master = keyring.keys.get(kid);
  if (!master) throw new Error(`Hosted credential key '${kid}' is not in the keyring — cannot decrypt`);
  const key = accountKey(master, accountId);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]);
  return pt.toString("utf8");
}

export function isSealedUnderPrimary(env: SecretEnvelope): boolean {
  const primary = hostedPrimaryKid();
  return primary != null && (env.kid ?? LEGACY_KID) === primary;
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
