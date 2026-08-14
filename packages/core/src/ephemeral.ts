// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Ephemeral compute — bring-your-own Fly.io / Hetzner / AWS token, spin up a
// short-lived node, tear it down. Ported from public/app/ephemeral-keys.js and
// ephemeral-provision.js.
//
// The provider token lives on THIS DEVICE (IndexedDB), never on the control
// plane. All provider-specific logic runs client-side, behind the
// `ProviderAdapter` contract below; the only thing another party does is make
// one allowlisted HTTPS request on our behalf (the browser can't call the
// provider's API directly — no CORS). That party is an `ExecFn`:
//   - cloud relay: the control plane forwards the request and never stores it, or
//   - node broker: an online node runs it over the E2E relay (control plane blind).
//
// Adding a new provider needs no changes to any of the above — just a new
// `ProviderAdapter` (below), a catalog entry, and its API host(s) added to
// `ALLOWED_HOSTS` (and the two other allowlists it must stay in lock-step
// with: `EPHEMERAL_ALLOWED_HOSTS` in src/ephemeral-exec.ts, and the
// control-plane's cold-start relay in services/control-plane/src/index.ts).
// See docs/ephemeral-sessions.md#adding-a-new-provider for the full checklist.

import { b64, b64url, unb64url } from "./base64.js";
import type { LocalStore } from "./local-store.js";
import type { EphemeralNodeConfig } from "./account.js";
import type { Command, PromptAttachment } from "./protocol.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface EphemeralProviderCatalog {
  id: string;
  name: string;
  /** Strategic/runtime boundary, shared by every onboarding surface. Managed
   * compute is useful but is not evidence for Bivy's no-markup BYO-cloud moat. */
  computeClass: "byo-cloud" | "managed-compute";
  maturity: "stable" | "experimental";
  tokenLabel: string;
  blurb: string;
  steps: string[];
  links: { label: string; url: string }[];
  /** Mirrors the adapter's `guestCanEnsureDeletion === false`: this provider's
   * guest shutdown does not stop billing, so a device-only (browser-held
   * token) launch is refused outright — only hosted/control-plane
   * provisioning (which retains independent deletion authority) can launch
   * it. Onboarding surfaces should say so up front rather than let the user
   * connect a token and hit the launch-time refusal cold. */
  hostedOnly?: boolean;
}

export const EPHEMERAL_PROVIDERS: EphemeralProviderCatalog[] = [
  {
    id: "fly",
    name: "Fly.io",
    computeClass: "byo-cloud",
    maturity: "stable",
    tokenLabel: "Fly.io access token",
    blurb: "Bivy creates a temporary Fly Machine, runs the session, then destroys it.",
    steps: [
      "Open your Fly.io access tokens and sign in.",
      "Click Create token — use a short-lived/deploy token if your account offers one.",
      "Copy the token and paste it below. Revoke it after the session if you like.",
    ],
    links: [
      { label: "Create a Fly.io token", url: "https://fly.io/user/personal_access_tokens" },
      { label: "Fly Machines docs", url: "https://fly.io/docs/machines/" },
    ],
  },
  {
    id: "hetzner",
    name: "Hetzner Cloud",
    computeClass: "byo-cloud",
    maturity: "stable",
    tokenLabel: "Hetzner Cloud API token",
    blurb: "Powering off a Hetzner server doesn't stop billing, so Bivy only launches one through hosted (control-plane) provisioning, which keeps independent deletion authority.",
    steps: [
      "Open the Hetzner Cloud Console and select or create a project for Bivy's runners.",
      "Go to Security → API Tokens and click Generate API token.",
      "Choose Read & Write, then copy the token and paste it below.",
    ],
    links: [
      { label: "Hetzner Cloud Console", url: "https://console.hetzner.cloud/projects" },
      { label: "API token docs", url: "https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/" },
    ],
    hostedOnly: true,
  },
  {
    id: "sprites",
    name: "Fly Sprites",
    computeClass: "managed-compute",
    maturity: "experimental",
    tokenLabel: "Sprites API token",
    blurb: "A machine that remembers: suspends to ~$0 when idle and resumes with everything intact. Reopen the session to wake it.",
    steps: [
      "Sign in at sprites.dev and open your account page.",
      "Create an API token (or run `sprite org auth` in the Sprites CLI).",
      "Copy the token and paste it below. It stays on this device.",
    ],
    links: [
      { label: "Sprites account & tokens", url: "https://sprites.dev/account" },
      { label: "Sprites docs", url: "https://docs.sprites.dev/" },
    ],
  },
  {
    id: "e2b",
    name: "E2B",
    computeClass: "managed-compute",
    maturity: "experimental",
    tokenLabel: "E2B API key",
    blurb: "A managed sandbox that ends itself: after a server-enforced timeout it pauses to ~$0 (resume with state intact) — no device needed to keep it in check.",
    steps: [
      "Sign in at e2b.dev and open your dashboard.",
      "Go to Team → API Keys and create a key.",
      "Copy the key and paste it below. It stays on this device.",
    ],
    links: [
      { label: "E2B dashboard & API keys", url: "https://e2b.dev/dashboard" },
      { label: "E2B docs", url: "https://e2b.dev/docs" },
    ],
  },
  {
    id: "aws",
    name: "AWS EC2",
    computeClass: "byo-cloud",
    maturity: "stable",
    tokenLabel: "Access key — paste as accessKeyId:secretAccessKey",
    blurb: "Bivy launches a temporary EC2 instance, runs the session, then terminates it.",
    steps: [
      "Create (or reuse) an IAM user scoped to a minimal EC2 policy — see the Bivy docs link below for a copy-pasteable policy.",
      "On that user, open Security credentials → Access keys → Create access key.",
      "Paste both values below as accessKeyId:secretAccessKey (append :sessionToken if you're using temporary STS credentials).",
    ],
    links: [
      { label: "IAM access keys", url: "https://console.aws.amazon.com/iam/home#/security_credentials" },
      { label: "EC2 console", url: "https://console.aws.amazon.com/ec2/home" },
      { label: "Minimal IAM policy (Bivy docs)", url: "https://github.com/bivysh/bivy/blob/main/docs/ephemeral-sessions.md#aws-ec2" },
    ],
  },
];

export function ephemeralCatalogEntry(id: string): EphemeralProviderCatalog | null {
  const key = String(id || "").trim().toLowerCase();
  return EPHEMERAL_PROVIDERS.find((p) => p.id === key) || null;
}

// --- device-local stores (provider tokens, launched machines) --------------

export interface KvBackend {
  getAll(): Promise<any[]>;
  put(key: string, value: any): Promise<void>;
  delete(key: string): Promise<void>;
}

export function memoryBackend(): KvBackend {
  const map = new Map<string, any>();
  return {
    async getAll() {
      return [...map.values()].map((r) => ({ ...r }));
    },
    async put(key, value) {
      map.set(key, { ...value });
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

export function indexedDbBackend(idb: IDBFactory, dbName: string, storeName: string, keyPath: string): KvBackend {
  function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = idb.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName, { keyPath });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function store(db: IDBDatabase, mode: IDBTransactionMode) {
    return db.transaction(storeName, mode).objectStore(storeName);
  }
  function promisify<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return {
    async getAll() {
      const db = await open();
      try {
        return (await promisify(store(db, "readonly").getAll())) || [];
      } finally {
        db.close();
      }
    },
    async put(_key, value) {
      const db = await open();
      try {
        await promisify(store(db, "readwrite").put(value));
      } finally {
        db.close();
      }
    },
    async delete(key) {
      const db = await open();
      try {
        await promisify(store(db, "readwrite").delete(key));
      } finally {
        db.close();
      }
    },
  };
}

function defaultBackend(storeName: string, keyPath: string): KvBackend {
  try {
    const idb = (globalThis as any).indexedDB as IDBFactory | undefined;
    // Each store gets its own database. They used to share one DB opened at a
    // fixed version, so `onupgradeneeded` only ran for whichever store opened
    // first — the others were never created and their transactions failed with
    // "object store not found". One DB per store sidesteps that entirely. The
    // token store keeps the original DB name so already-saved tokens survive.
    if (idb) {
      const dbName = storeName === "provider-keys" ? "bivy-ephemeral" : `bivy-ephemeral-${storeName}`;
      return indexedDbBackend(idb, dbName, storeName, keyPath);
    }
  } catch {
    /* fall through to memory */
  }
  return memoryBackend();
}

export interface ProviderKeyInfo {
  id: string;
  name: string;
  configured: boolean;
  updatedAt: string | null;
}

export interface EphemeralKeyStore {
  list(): Promise<ProviderKeyInfo[]>;
  getToken(id: string): Promise<string>;
  setToken(id: string, token: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createEphemeralKeyStore(backend: KvBackend = defaultBackend("provider-keys", "provider")): EphemeralKeyStore {
  return {
    async list() {
      let stored: any[] = [];
      try {
        stored = await backend.getAll();
      } catch {
        stored = [];
      }
      const byId = new Map(stored.map((r) => [r.provider, r]));
      return EPHEMERAL_PROVIDERS.map((p) => {
        const rec = byId.get(p.id);
        return { id: p.id, name: p.name, configured: Boolean(rec && rec.token), updatedAt: rec ? rec.updatedAt : null };
      });
    },
    async getToken(id) {
      const entry = ephemeralCatalogEntry(id);
      if (!entry) return "";
      let stored: any[] = [];
      try {
        stored = await backend.getAll();
      } catch {
        return "";
      }
      const rec = stored.find((r) => r.provider === entry.id);
      return rec && rec.token ? rec.token : "";
    },
    async setToken(id, token) {
      const entry = ephemeralCatalogEntry(id);
      if (!entry) throw new Error(`Unknown ephemeral provider: ${id}`);
      const value = String(token || "").trim();
      if (!value) throw new Error("API token cannot be empty");
      await backend.put(entry.id, { provider: entry.id, token: value, updatedAt: nowIso() });
    },
    async remove(id) {
      const entry = ephemeralCatalogEntry(id);
      if (!entry) return;
      await backend.delete(entry.id);
    },
  };
}

export type DeviceCredentialScope = "device" | "account";

export interface EphemeralModelKeyInfo {
  provider: string;
  configured: boolean;
  updatedAt: string | null;
  /** Account keys enter the E2E device vault; device keys never leave this PWA. */
  scope: DeviceCredentialScope;
}

export interface EphemeralModelKeyEntry {
  provider: string;
  key: string;
  updatedAt?: string | null;
  scope: DeviceCredentialScope;
}

/**
 * Device-local store for the model **API keys** used to seed a freshly-launched
 * ephemeral machine's vault over the paired E2E channel — closing the cold-start
 * gap where a first-ever node has no peer to sync the model-auth vault from (see
 * docs/ephemeral-sessions.md, "Closing the cold-start gap").
 *
 * Same privacy model as the cloud provider tokens above: IndexedDB on THIS
 * device, never sent to the control plane, never baked into user-data. Keyed by
 * model-provider id (e.g. "anthropic", "openai") — an opaque, lower-cased string
 * this store doesn't validate, since the model-provider set is open-ended and
 * lives on the node, not here. API keys only; agent-native OAuth logins are out
 * of scope (fragile to replay onto disposable machines — see credential-sync.md).
 */
export interface EphemeralModelKeyStore {
  /** Metadata for the UI — provider id + whether a key is saved. No secrets. */
  list(): Promise<EphemeralModelKeyInfo[]>;
  /** The stored keys, for seeding a node. Secrets — never surface in the UI. */
  entries(): Promise<EphemeralModelKeyEntry[]>;
  get(provider: string): Promise<string>;
  set(provider: string, key: string, scope?: DeviceCredentialScope): Promise<void>;
  remove(provider: string): Promise<void>;
}

export function createEphemeralModelKeyStore(
  backend: KvBackend = defaultBackend("model-keys", "provider"),
): EphemeralModelKeyStore {
  const norm = (p: string) => String(p || "").trim().toLowerCase();
  const all = async (): Promise<any[]> => {
    try {
      return await backend.getAll();
    } catch {
      return [];
    }
  };
  return {
    async list() {
      const stored = await all();
      return stored
        .filter((r) => r && r.provider)
        .map((r) => ({
          provider: String(r.provider),
          configured: Boolean(r.key),
          updatedAt: r.updatedAt ?? null,
          // Existing ephemeral seed keys become account keys: this preserves their
          // old purpose (making a newly-created node usable) while moving them to
          // the unified account vault.
          scope: r.scope === "device" ? "device" as const : "account" as const,
        }))
        .sort((a, b) => a.provider.localeCompare(b.provider));
    },
    async entries() {
      const stored = await all();
      return stored
        .filter((r) => r && r.provider && r.key)
        .map((r) => ({
          provider: String(r.provider),
          key: String(r.key),
          updatedAt: r.updatedAt ?? null,
          scope: r.scope === "device" ? "device" as const : "account" as const,
        }));
    },
    async get(provider) {
      const id = norm(provider);
      if (!id) return "";
      const rec = (await all()).find((r) => r.provider === id);
      return rec && rec.key ? rec.key : "";
    },
    async set(provider, key, scope = "account") {
      const id = norm(provider);
      if (!id) throw new Error("Provider is required");
      const value = String(key || "").trim();
      if (!value) throw new Error("API key cannot be empty");
      if (scope !== "account" && scope !== "device") throw new Error("Credential scope must be account or device");
      await backend.put(id, { provider: id, key: value, scope, updatedAt: nowIso() });
    },
    async remove(provider) {
      const id = norm(provider);
      if (!id) return;
      await backend.delete(id);
    },
  };
}

/**
 * Device-local store for the GitHub token an ephemeral node uses to run
 * queued issue work (issue #532) — same privacy model as the provider keys
 * above (IndexedDB on this device; never sent to the control plane), but a
 * single value rather than one per provider, since it's not provider-specific.
 * Optional: queue items still dispatch to an ephemeral server without one, they
 * just can't authenticate to GitHub once there (clone/push/PR all fail).
 */
export interface GithubTaskTokenStore {
  get(): Promise<string>;
  set(token: string): Promise<void>;
  remove(): Promise<void>;
}

const GITHUB_TASK_TOKEN_KEY = "github-task-token";

export function createGithubTaskTokenStore(backend: KvBackend = defaultBackend("github-task-token", "id")): GithubTaskTokenStore {
  return {
    async get() {
      let stored: any[] = [];
      try {
        stored = await backend.getAll();
      } catch {
        return "";
      }
      const rec = stored.find((r) => r.id === GITHUB_TASK_TOKEN_KEY);
      return rec && rec.token ? rec.token : "";
    },
    async set(token) {
      const value = String(token || "").trim();
      if (!value) throw new Error("GitHub token cannot be empty");
      await backend.put(GITHUB_TASK_TOKEN_KEY, { id: GITHUB_TASK_TOKEN_KEY, token: value, updatedAt: nowIso() });
    },
    async remove() {
      await backend.delete(GITHUB_TASK_TOKEN_KEY);
    },
  };
}

/**
 * Device-local, per-provider launch preferences (issue: "Ephemeral machines"
 * Settings screen). These are the saved defaults a user configures once — region,
 * server size, auto-destroy TTL, and an optional repo — so the new-session launch
 * flow can pre-fill them instead of asking from scratch every time. Same privacy
 * model as the provider tokens (IndexedDB on this device; never sent to the
 * control plane). A `null` field means "no preference — fall back to the
 * provider adapter's default".
 */
export interface EphemeralPrefs {
  region: string | null;
  size: string | null;
  ttlMinutes: number | null;
  repo: string | null;
  /** Ask the launching device to destroy the provider machine after agent_end.
   * TTL remains a safety fallback if that device is no longer online. */
  teardownOnAgentFinish: boolean;
}

export interface EphemeralPrefsStore {
  get(id: string): Promise<EphemeralPrefs>;
  set(id: string, patch: Partial<EphemeralPrefs>): Promise<EphemeralPrefs>;
  remove(id: string): Promise<void>;
}

/** A reusable ephemeral node definition. Unlike a running machine, a setup is
 * device-local configuration and remains available after its machine expires. */
export interface EphemeralSetup extends EphemeralPrefs {
  id: string;
  provider: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface EphemeralSetupStore {
  list(provider?: string): Promise<EphemeralSetup[]>;
  get(id: string): Promise<EphemeralSetup | null>;
  create(provider: string, input: { name: string } & Partial<EphemeralPrefs>): Promise<EphemeralSetup>;
  update(id: string, patch: Partial<Pick<EphemeralSetup, "name" | keyof EphemeralPrefs>>): Promise<EphemeralSetup>;
  remove(id: string): Promise<void>;
}

const EMPTY_PREFS: EphemeralPrefs = { region: null, size: null, ttlMinutes: null, repo: null, teardownOnAgentFinish: false };

export function createEphemeralPrefsStore(
  backend: KvBackend = defaultBackend("provider-prefs", "provider"),
): EphemeralPrefsStore {
  const read = async (id: string): Promise<EphemeralPrefs> => {
    const entry = ephemeralCatalogEntry(id);
    if (!entry) return { ...EMPTY_PREFS };
    let stored: any[] = [];
    try {
      stored = await backend.getAll();
    } catch {
      return { ...EMPTY_PREFS };
    }
    const rec = stored.find((r) => r.provider === entry.id);
    if (!rec) return { ...EMPTY_PREFS };
    return {
      region: rec.region ?? null,
      size: rec.size ?? null,
      ttlMinutes: typeof rec.ttlMinutes === "number" ? rec.ttlMinutes : null,
      repo: rec.repo ?? null,
      teardownOnAgentFinish: rec.teardownOnAgentFinish === true,
    };
  };
  return {
    get: read,
    async set(id, patch) {
      const entry = ephemeralCatalogEntry(id);
      if (!entry) throw new Error(`Unknown ephemeral provider: ${id}`);
      const current = await read(entry.id);
      const next: EphemeralPrefs = { ...current, ...patch };
      await backend.put(entry.id, { provider: entry.id, ...next, updatedAt: nowIso() });
      return next;
    },
    async remove(id) {
      const entry = ephemeralCatalogEntry(id);
      if (!entry) return;
      await backend.delete(entry.id);
    },
  };
}

function setupId(): string {
  try {
    return "setup-" + randHex(8);
  } catch {
    return `setup-${Math.random().toString(16).slice(2)}`;
  }
}

/** Multiple named configurations may be saved for the same cloud provider.
 * They intentionally live in a new store so the old per-provider defaults can
 * continue to pre-fill ad-hoc launches and existing users lose no settings. */
export function createEphemeralSetupStore(
  backend: KvBackend = defaultBackend("setups", "id"),
): EphemeralSetupStore {
  const all = async (): Promise<EphemeralSetup[]> => {
    try {
      return (await backend.getAll())
        .filter((r) => r && r.id && ephemeralCatalogEntry(r.provider))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    } catch {
      return [];
    }
  };
  return {
    async list(provider) {
      const rows = await all();
      if (!provider) return rows;
      const entry = ephemeralCatalogEntry(provider);
      return entry ? rows.filter((r) => r.provider === entry.id) : [];
    },
    async get(id) {
      return (await all()).find((r) => r.id === id) ?? null;
    },
    async create(provider, input) {
      const entry = ephemeralCatalogEntry(provider);
      if (!entry) throw new Error(`Unknown ephemeral provider: ${provider}`);
      const name = String(input.name || "").trim();
      if (!name) throw new Error("Setup name is required");
      const now = nowIso();
      const setup: EphemeralSetup = {
        id: setupId(), provider: entry.id, name, ...EMPTY_PREFS,
        region: input.region ?? null, size: input.size ?? null,
        ttlMinutes: input.ttlMinutes ?? null, repo: input.repo ?? null,
        teardownOnAgentFinish: input.teardownOnAgentFinish === true,
        createdAt: now, updatedAt: now,
      };
      await backend.put(setup.id, setup);
      return setup;
    },
    async update(id, patch) {
      const current = (await all()).find((r) => r.id === id);
      if (!current) throw new Error("Ephemeral setup not found");
      const next = { ...current, ...patch, id: current.id, provider: current.provider, updatedAt: nowIso() };
      next.name = String(next.name || "").trim();
      if (!next.name) throw new Error("Setup name is required");
      await backend.put(id, next);
      return next;
    },
    async remove(id) {
      await backend.delete(id);
    },
  };
}

/** Device-local durable intent for a first message waiting on an ephemeral
 * runner. Prompt content stays on the user's device; the control plane only
 * receives it later through the normal encrypted relay. */
export interface PendingEphemeralLaunch {
  id: string;
  config: EphemeralNodeConfig;
  prompt: {
    text: string;
    requestId: string;
    clientMessageId: string;
    attachments?: PromptAttachment[];
    frame: Command;
  };
  followups: Array<{ text: string; clientMessageId: string; attachments?: PromptAttachment[] }>;
  logs: string[];
  phase: "provisioning" | "booting" | "failed";
  machine?: EphemeralMachine;
  createdAt: string;
  updatedAt: string;
}

export interface PendingEphemeralLaunchStore {
  list(): Promise<PendingEphemeralLaunch[]>;
  put(launch: PendingEphemeralLaunch): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createPendingEphemeralLaunchStore(
  backend: KvBackend = defaultBackend("pending-launches", "id"),
): PendingEphemeralLaunchStore {
  return {
    async list() {
      try {
        return (await backend.getAll())
          .filter((r) => r && r.id && r.config && r.prompt)
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) as PendingEphemeralLaunch[];
      } catch {
        return [];
      }
    },
    async put(launch) {
      await backend.put(launch.id, launch);
    },
    async remove(id) {
      await backend.delete(id);
    },
  };
}

export interface EphemeralMachine {
  id: string;
  provider: string;
  name: string;
  region: string;
  size?: string;
  status: string; // starting | running | stopped | gone
  ip: string | null;
  createdAt: string;
  /** Stable id for the launch operation. Provider resources are tagged with it
   * and idempotent create APIs use it, so a controller can recover an accepted
   * create whose response was lost instead of launching a duplicate. */
  attemptId?: string;
  /** Cold-start timestamps. `requestedAt` begins the user-visible budget;
   * `providerAcceptedAt` means the create API returned, not that the agent is
   * ready. Later milestones are server-stamped from the enrolled node. */
  milestones?: EphemeralMilestones;
  ttlMinutes?: number;
  /** Destroy after the agent completes its turn; TTL is still the fallback. */
  teardownOnAgentFinish?: boolean;
  app?: string;
  nodeId?: string;
  /** The device-local `EphemeralSetup` this machine was launched from, when it
   *  came from a saved setup rather than an ad-hoc launch. Lets the UI tie a
   *  running machine back to its configured node (e.g. so the node switcher can
   *  show a setup as online and switch to it instead of re-launching). */
  setupId?: string;
  repo?: string;
  /** The GitHub work-queue item this machine was provisioned to run, when
   *  launched from the queue's per-item "Run on ephemeral server" action
   *  (issue #532). Lets the launching device watch that item for completion
   *  and tear the machine down once it's done. */
  workItemId?: string;
  /** Why this machine was launched: a manual "Ephemeral machine" launch
   *  (undefined, the pre-#532 default), a specific queue item ("queue-item"),
   *  or a general-purpose queue worker for the account's ephemeral default
   *  ("queue-default"). Display/bookkeeping only. */
  purpose?: "queue-item" | "queue-default" | "ready-capacity";
}

export interface EphemeralMilestones {
  requestedAt?: string;
  providerAcceptedAt?: string;
  nodeReadyAt?: string;
  credentialsReadyAt?: string;
  snapshotReadyAt?: string;
  firstAgentEventAt?: string;
}

export function ephemeralColdStartMs(machine: Pick<EphemeralMachine, "milestones">): number | undefined {
  const start = Date.parse(String(machine.milestones?.requestedAt || ""));
  const ready = Date.parse(String(machine.milestones?.firstAgentEventAt || ""));
  return Number.isFinite(start) && Number.isFinite(ready) && ready >= start ? ready - start : undefined;
}

export interface MachineStore {
  list(): Promise<EphemeralMachine[]>;
  add(machine: EphemeralMachine): Promise<EphemeralMachine>;
  update(id: string, patch: Partial<EphemeralMachine>): Promise<EphemeralMachine | null>;
  remove(id: string): Promise<void>;
}

export function createMachineStore(backend: KvBackend = defaultBackend("machines", "id")): MachineStore {
  return {
    async list() {
      try {
        return (await backend.getAll()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      } catch {
        return [];
      }
    },
    async add(machine) {
      if (!machine || !machine.id) throw new Error("Machine record needs an id");
      await backend.put(machine.id, machine);
      return machine;
    },
    async update(id, patch) {
      const all = await backend.getAll().catch(() => []);
      const existing = all.find((m) => m.id === id);
      if (!existing) return null;
      const merged = { ...existing, ...patch };
      await backend.put(id, merged);
      return merged;
    },
    async remove(id) {
      await backend.delete(id);
    },
  };
}

// --- provisioning ----------------------------------------------------------

export interface ExecRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}
export interface ExecResult {
  status: number;
  body: any;
}
export type ExecFn = (request: ExecRequest) => Promise<ExecResult>;

// AWS has no single API host — EC2 and SSM (used to resolve the current
// Ubuntu AMI) are per-region. Only the regions offered in the `aws` adapter's
// `regions` list below are allowlisted; add both hosts here when adding a
// region there.
export const ALLOWED_HOSTS = [
  "api.hetzner.cloud",
  "api.machines.dev",
  "api.fly.io",
  "api.sprites.dev",
  "api.e2b.app",
  "ec2.us-east-1.amazonaws.com",
  "ec2.us-west-2.amazonaws.com",
  "ec2.eu-west-1.amazonaws.com",
  "ec2.eu-central-1.amazonaws.com",
  "ec2.ap-southeast-1.amazonaws.com",
  "ec2.ap-northeast-1.amazonaws.com",
  "ssm.us-east-1.amazonaws.com",
  "ssm.us-west-2.amazonaws.com",
  "ssm.eu-west-1.amazonaws.com",
  "ssm.eu-central-1.amazonaws.com",
  "ssm.ap-southeast-1.amazonaws.com",
  "ssm.ap-northeast-1.amazonaws.com",
];

export function assertAllowedUrl(url: string): string {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new Error(`Bad provider URL: ${url}`);
  }
  if (!ALLOWED_HOSTS.includes(host)) throw new Error(`Refusing to send a token to non-provider host: ${host}`);
  return url;
}

async function call(exec: ExecFn, request: ExecRequest): Promise<ExecResult> {
  assertAllowedUrl(request.url);
  const res = await exec(request);
  return res || { status: 0, body: null };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${String(token || "").trim()}` };
}

function shq(s: unknown): string {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}
function indentJson(json: string, pad: string): string {
  return json.split("\n").map((l) => pad + l).join("\n");
}
function nowIso(): string {
  // Date is unavailable in some sandboxes; guard so pure imports don't throw.
  try {
    return new Date().toISOString();
  } catch {
    return "";
  }
}

export interface BootstrapOpts {
  relayUrl: string;
  controlPlaneUrl: string;
  enrollmentToken: string;
  e2eKeyB64: string;
  ttlMinutes?: number;
  repo?: string;
  installUrl?: string;
  /** Opt the freshly-booted node into the hosted GitHub work queue (the same
   *  switch as the `BIVY_GITHUB_HOSTED_TASKS` node env var) — see
   *  `ControlPlaneTaskPoller`/`resolveControlPlaneTaskConfig` in
   *  src/control-plane-tasks.ts. Lets the machine serve queue items with no
   *  persistent node required (issue #532). */
  hostedTasks?: boolean;
  /** The routing-label suffix this node should additionally serve, e.g.
   *  "ab12cd34" so it also polls `bivy/ab12cd34` (see `BIVY_NODE_LABEL` in
   *  src/control-plane-tasks.ts). Lets a queue item be targeted at THIS
   *  ephemeral machine specifically, via the normal assign-to-node flow. */
  nodeLabel?: string;
  /** A GitHub token (PAT) the node uses to clone/push/open PRs for hosted
   *  queue work, since a fresh machine has no `gh auth login` of its own. Rides
   *  in the same device→provider user_data as the relay enrollment token/E2E
   *  key above — never sent to the control plane. */
  githubToken?: string;
  /** Have the machine self-mint a GitHub token from the control plane per git op
   *  (exports BIVY_HOSTED_MINT) instead of carrying a static token — the hosted
   *  GitHub App path, so no long-lived credential ever lands on the machine. */
  hostedMint?: boolean;
  /** The ephemeral provider this machine runs on (`fly`/`hetzner`/`aws`/…). Lets
   *  the daemon learn it's disposable and, for destroy-lane providers, end the
   *  machine itself once idle — see `bivyBootstrapExports`/src/ephemeral-teardown.ts.
   *  Suspend-to-zero providers (Sprites/E2B) are kept, so no self-teardown env is
   *  emitted for them. */
  provider?: string;
  /** Ask the daemon to tear the machine down promptly after the agent finishes
   *  (a short grace), not just at the idle window — the server-side equivalent of
   *  the device's "Destroy when the agent finishes" toggle, so it no longer needs
   *  the launching device to stay online. */
  teardownOnAgentFinish?: boolean;
  /** DEBUG: disable Fly `auto_destroy` so a boot-failed machine stays (stopped)
   *  with its logs retained, instead of vanishing. Staging diagnosis only. */
  debugKeepMachine?: boolean;
  /** Rebuild-resume (Gap B): the session id to restore from its control-plane
   *  snapshot on boot (exported as `BIVY_RESTORE`). The machine reuses this
   *  session's node id + room key so it can fetch and decrypt the snapshot. */
  restoreSessionId?: string;
}

/** Clamp a requested TTL into a sane 5-minute…24-hour window (default 60). A
 *  forgotten machine can't bill forever, and a too-short TTL can't kill a node
 *  before it finishes booting. */
export function clampTtlMinutes(ttlMinutes?: number): number {
  return Math.max(5, Math.min(24 * 60, Number(ttlMinutes) || 60));
}

/** The relay enrollment blob written to `/etc/bivy/relay.json`. The daemon reads
 *  it on boot (`startRelayIfConfigured` in src/server.ts) and dials the relay
 *  with no interactive `bivy setup` — the node was already enrolled by the
 *  launching device. */
function bivyRelayJson(opts: BootstrapOpts): string {
  return JSON.stringify({
    url: opts.relayUrl,
    enrollmentToken: opts.enrollmentToken,
    e2eKey: opts.e2eKeyB64,
    controlPlaneUrl: opts.controlPlaneUrl,
    clientBaseUrl: opts.controlPlaneUrl,
  });
}

/** The `export`s the daemon needs in its runtime env. `BIVY_DATA_DIR` points at
 *  the pre-baked `/etc/bivy` (relay.json + state); the rest are independently
 *  optional (repo, hosted-queue opt-in, routing label, GitHub token). Shared by
 *  the cloud-init (Hetzner/EC2) and Fly bootstraps so a node's env is identical
 *  however it was launched. */
function bivyBootstrapExports(opts: BootstrapOpts): string[] {
  // Destroy-lane providers learn they're disposable so the daemon can end the
  // machine itself once idle (src/ephemeral-teardown.ts). Suspend-to-zero
  // providers (Sprites/E2B) are KEPT, so they get no self-teardown env.
  const ephemeral = Boolean(opts.provider) && !ephemeralProviderSuspendsWhenIdle(opts.provider as string);
  return [
    "export BIVY_DATA_DIR=/etc/bivy",
    opts.repo ? `export BIVY_REPO=${shq(opts.repo)}` : "",
    opts.hostedTasks ? `export BIVY_GITHUB_HOSTED_TASKS=1` : "",
    opts.nodeLabel ? `export BIVY_NODE_LABEL=${shq(opts.nodeLabel)}` : "",
    opts.githubToken ? `export BIVY_GITHUB_TOKEN=${shq(opts.githubToken)}` : "",
    opts.hostedMint ? `export BIVY_HOSTED_MINT=1` : "",
    ephemeral ? `export BIVY_EPHEMERAL=1` : "",
    ephemeral ? `export BIVY_EPHEMERAL_PROVIDER=${shq(opts.provider)}` : "",
    ephemeral ? `export BIVY_EPHEMERAL_TTL_MIN=${clampTtlMinutes(opts.ttlMinutes)}` : "",
    ephemeral && opts.teardownOnAgentFinish ? `export BIVY_TEARDOWN_ON_FINISH=1` : "",
    ephemeral && opts.restoreSessionId ? `export BIVY_RESTORE=${shq(opts.restoreSessionId)}` : "",
  ].filter(Boolean);
}

/** `/etc/bivy/start.sh` — exports the runtime env then runs the daemon in the
 *  FOREGROUND (`exec bivy start`). This is the piece that was missing: the
 *  installer only *installs* Bivy, it never starts the node when there's no TTY
 *  (a headless, pre-enrolled machine). cloud-init runs this under `systemd-run`
 *  (a VM stays up on its own); Fly runs it as the machine's init process (a
 *  container needs a blocking foreground process or it exits and is destroyed).
 *  PATH is set explicitly because a non-login `systemd-run`/container shell
 *  doesn't source the rc file the installer appends BIN_DIR to. */
function bivyStartScript(opts: BootstrapOpts): string {
  const exports = bivyBootstrapExports(opts)
    .map((line) => `${line}\n`)
    .join("");
  return (
    "#!/bin/bash\n" +
    'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin:$PATH"\n' +
    exports +
    "exec bivy start\n"
  );
}

export function buildBootstrapUserData(opts: BootstrapOpts): string {
  const relay = bivyRelayJson(opts);
  const ttl = clampTtlMinutes(opts.ttlMinutes);
  const installUrl = opts.installUrl || "https://bivy.sh/install.sh";
  const startScript = bivyStartScript(opts);
  const status = (phase: string) =>
    `curl -fsS -X POST -H 'content-type: application/json' -H ${shq(`authorization: Bearer ${opts.enrollmentToken}`)} --data ${shq(JSON.stringify({ phase }))} ${shq(`${opts.controlPlaneUrl.replace(/\/$/, "")}/node/bootstrap-status`)} >/dev/null 2>&1 || true`;
  return (
    [
      "#cloud-config",
      "write_files:",
      "  - path: /etc/bivy/relay.json",
      "    permissions: '0600'",
      "    content: |",
      indentJson(relay, "      "),
      "  - path: /etc/bivy/start.sh",
      "    permissions: '0755'",
      "    content: |",
      indentJson(startScript, "      "),
      "runcmd:",
      `  - [ bash, -lc, ${JSON.stringify(status("booting"))} ]`,
      // 1. Install Bivy (state lands in /etc/bivy via BIVY_DATA_DIR).
      `  - [ bash, -lc, ${JSON.stringify(`${status("installing")}; mkdir -p /etc/bivy && export BIVY_DATA_DIR=/etc/bivy && (command -v bivy >/dev/null 2>&1 || curl -fsSL ${shq(installUrl)} | bash) || { ${status("failed")}; exit 1; }`)} ]`,
      // 2. Start the daemon. On a systemd VM a transient system unit keeps it
      `  - [ bash, -lc, ${JSON.stringify(status("starting"))} ]`,
      //    running after cloud-init's own unit exits (a bare backgrounded process
      //    would be cleaned up with cloud-final's cgroup); the setsid fallback
      //    covers a rare image without systemd-run.
      `  - [ bash, -lc, "systemd-run --unit=bivy --collect --property=Restart=on-failure /etc/bivy/start.sh || setsid bash /etc/bivy/start.sh </dev/null >/var/log/bivy.log 2>&1 &" ]`,
      // 3. TTL backstop: halt the VM so a forgotten machine can't bill forever.
      //    Prefer a systemd-run transient timer — it's owned by systemd, so it
      //    survives cloud-init exiting (unlike a bare backgrounded `sleep`, which
      //    cloud-final's cgroup reaps — the same reason step 2 uses systemd-run).
      //    Fall back to `at`, then to a detached setsid `sleep` for the rare image
      //    with neither, so the machine self-halts however minimal the base image.
      `  - [ bash, -lc, "systemd-run --on-active=${ttl}m --timer-property=AccuracySec=1s --unit=bivy-ttl shutdown -h now || (echo 'shutdown -h now' | at now + ${ttl} minutes) || setsid bash -c 'sleep ${ttl * 60}; shutdown -h now' </dev/null >/var/log/bivy-ttl.log 2>&1 &" ]`,
    ].join("\n") + "\n"
  );
}

/** A pickable machine size. `id` is the provider-native identifier that gets
 *  passed back as `config.size` at provision time. */
export interface ProviderSize {
  id: string;
  label: string;
  /** Approximate on-demand compute price per hour in the provider's currency
   *  (see `ProviderAdapter.currency`), for showing an at-a-glance cost estimate
   *  before launch. Indicative only — the provider's live bill is authoritative;
   *  storage/egress/taxes aren't included. Absent when we have no figure. */
  pricePerHour?: number;
}

/** Currency symbol for the small cost hints. Kept tiny on purpose — these are
 *  indicative estimates, not an invoice. */
function currencySymbol(currency: string): string {
  return currency === "EUR" ? "€" : "$";
}

/** Format one price, e.g. `$0.0136` or `€0.007`. Sub-10-cent prices get more
 *  decimals so a cheap machine doesn't collapse to `$0.01` or `$0.00`. */
export function formatEphemeralPrice(amount: number, currency = "USD"): string {
  const sym = currencySymbol(currency);
  const digits = amount < 0.1 ? 4 : 2;
  return `${sym}${amount.toFixed(digits)}`;
}

/** The one-line cost hint shown next to a chosen size: the hourly rate plus the
 *  estimated ceiling for the selected TTL. Returns "" when we have no price for
 *  the size, so callers can render it unconditionally. */
export function ephemeralCostHint(
  size: ProviderSize | undefined,
  ttlMinutes: number | undefined,
  currency = "USD",
): string {
  const rate = size?.pricePerHour;
  if (!rate || rate <= 0) return "";
  const perHour = `≈ ${formatEphemeralPrice(rate, currency)}/hr`;
  if (!ttlMinutes || ttlMinutes <= 0) return perHour;
  const hours = clampTtlMinutes(ttlMinutes) / 60;
  return `${perHour} · up to ${formatEphemeralPrice(rate * hours, currency)} before it self-destructs`;
}

export type EphemeralLifecyclePhase = "provisioning" | "node-ready" | "hydrating" | "ready" | "claimed" | "working" | "teardown-failed";

/** User-facing lifecycle derived only from durable, server-stamped facts. */
export function ephemeralLifecyclePhase(
  machine: Pick<EphemeralMachine, "milestones" | "purpose"> & { claimedAt?: string },
  teardownFailed = false,
): EphemeralLifecyclePhase {
  if (teardownFailed) return "teardown-failed";
  if (machine.milestones?.firstAgentEventAt) return "working";
  if (machine.claimedAt || machine.purpose === "queue-default" || machine.purpose === "queue-item") return "claimed";
  if (machine.purpose === "ready-capacity" && machine.milestones?.credentialsReadyAt) return "ready";
  if (machine.milestones?.nodeReadyAt && !machine.milestones?.credentialsReadyAt) return "hydrating";
  if (machine.milestones?.nodeReadyAt) return "node-ready";
  return "provisioning";
}

export function ephemeralCostEstimate(
  size: ProviderSize | undefined,
  createdAt: string,
  ttlMinutes?: number,
  nowMs = Date.now(),
): { accrued: number; maximum: number } | null {
  const rate = size?.pricePerHour;
  const start = Date.parse(createdAt);
  if (!rate || rate <= 0 || !Number.isFinite(start)) return null;
  const ttl = clampTtlMinutes(ttlMinutes);
  const elapsedHours = Math.max(0, Math.min(nowMs - start, ttl * 60_000)) / 3_600_000;
  return { accrued: rate * elapsedHours, maximum: rate * ttl / 60 };
}

export interface ProviderAdapter {
  id: string;
  name: string;
  /** ISO currency code the provider bills in — drives the cost-hint symbol.
   *  Fly/AWS bill in USD, Hetzner in EUR. */
  currency: string;
  regions: { id: string; label: string }[];
  defaultRegion: string;
  sizes: ProviderSize[];
  defaultSize: string;
  /** Authenticate with a read-only provider request. Used during onboarding so
   * invalid/under-scoped credentials fail before Bivy stores or launches with
   * them. Must never create, update, wake, stop, or delete a resource. */
  validateToken?(args: { exec: ExecFn; token: string; region?: string }): Promise<void>;
  /** False when guest shutdown does not delete the paid resource. Such a
   * provider may launch only when an independent controller has teardown
   * credentials; device-only TTL shutdown is not a billing guarantee. */
  guestCanEnsureDeletion?: boolean;
  /** Optionally fetch the provider's live, currently-orderable sizes so the
   *  hardcoded `sizes` list can't silently go stale (e.g. a plan gets
   *  deprecated). When a region is given, results are narrowed to what that
   *  region can actually order. Falls back to `sizes` when absent or on error. */
  listSizes?(args: { exec: ExecFn; token: string; region?: string }): Promise<ProviderSize[]>;
  /** `userData` is the ready-made cloud-init payload (used by VM providers).
   *  `bootstrap` is the same intent in structured form, for providers that can't
   *  run cloud-init and must assemble their own boot config (Fly — see its
   *  adapter). Both describe one node; an adapter uses whichever it needs. */
  provision(args: { exec: ExecFn; token: string; config: any; userData: string; bootstrap?: BootstrapOpts }): Promise<EphemeralMachine>;
  status(args: { exec: ExecFn; token: string; machine: EphemeralMachine }): Promise<string>;
  destroy(args: { exec: ExecFn; token: string; machine: EphemeralMachine }): Promise<void>;
  /** List every live resource tagged with `ownershipTag` at the provider,
   *  independent of anything Bivy currently has tracked. This is the recovery
   *  path for the one failure #554's per-attempt idempotent-create/adopt can't
   *  cover: the durable attempt row itself being lost (both the row AND the
   *  legacy inventory array) after a resource was actually created. Only
   *  implemented for providers where an orphaned resource keeps billing
   *  (Hetzner/Fly/EC2) — a suspend-when-idle managed sandbox (Sprites/E2B)
   *  doesn't carry the same cost risk and is intentionally left without one. */
  discover?(args: { exec: ExecFn; token: string; ownershipTag: string }): Promise<EphemeralMachine[]>;
  /** True when the provider's machines suspend themselves to ~zero cost while
   *  idle and resume with full state (Fly Sprites). Such a machine is kept —
   *  never TTL-destroyed on finish — and is woken via `wake` before reconnect.
   *  Absent/false for the destroy-when-done providers (Fly Machines/Hetzner/AWS). */
  suspendsWhenIdle?: boolean;
  /** Resume a suspended machine so it rejoins the relay and becomes reachable.
   *  Only meaningful when `suspendsWhenIdle` — one allowlisted request that
   *  forces the machine warm (for Sprites, starting its supervised `bivy`
   *  service). Idempotent: safe to call on an already-running machine. */
  wake?(args: { exec: ExecFn; token: string; machine: EphemeralMachine }): Promise<void>;
}

export async function validateEphemeralProviderToken(
  provider: string,
  token: string,
  exec: ExecFn,
  region?: string,
): Promise<void> {
  const adapter = ephemeralAdapter(provider);
  if (!adapter) throw new Error(`Unknown provider: ${provider}`);
  const value = String(token || "").trim();
  if (!value) throw new Error(`${adapter.name} token is required`);
  if (!adapter.validateToken) throw new Error(`${adapter.name} credential validation is not available`);
  await adapter.validateToken({ exec, token: value, region: region || adapter.defaultRegion });
}

function mapHetznerStatus(s: string): string {
  return s === "running" ? "running" : s === "off" || s === "stopping" ? "stopped" : "starting";
}
function mapFlyStatus(s: string): string {
  return s === "started" ? "running" : s === "stopped" || s === "destroyed" ? "stopped" : "starting";
}

export function extractProviderMessage(body: any): string {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (typeof body.message === "string") return body.message;
  if (body.error && typeof body.error === "object") {
    const e = body.error;
    let m = typeof e.message === "string" ? e.message : typeof e.code === "string" ? e.code : "";
    const fields = e.details && Array.isArray(e.details.fields) ? e.details.fields : null;
    if (fields && fields.length) {
      const detail = fields
        .map((f: any) => `${f.name}: ${Array.isArray(f.messages) ? f.messages.join(", ") : f.messages || ""}`)
        .filter(Boolean)
        .join("; ");
      if (detail) m = m ? `${m} (${detail})` : detail;
    }
    return m;
  }
  if (typeof body.error === "string") return body.error;
  if (Array.isArray(body.errors) && body.errors.length) {
    return body.errors.map((e: any) => (typeof e === "string" ? e : e && e.message) || "").filter(Boolean).join("; ");
  }
  return "";
}

function providerError(res: ExecResult, action: string): string {
  const msg = extractProviderMessage(res && res.body);
  return `Provider failed to ${action} (HTTP ${res?.status}${msg ? `: ${msg}` : ""})`;
}

interface HetznerSize {
  typeId: number;
  id: string;
  label: string;
  cores: number;
  memory: number;
  pricePerHour?: number;
}

/** Pull an indicative hourly gross price (EUR) from a Hetzner server_type's
 *  per-location `prices` array. Region prices differ slightly; the first entry
 *  is close enough for an at-a-glance hint. Returns undefined when absent. */
function hetznerHourlyPrice(t: any): number | undefined {
  const prices = Array.isArray(t?.prices) ? t.prices : [];
  for (const p of prices) {
    const gross = Number(p?.price_hourly?.gross);
    if (Number.isFinite(gross) && gross > 0) return gross;
  }
  return undefined;
}

/**
 * Cache a promise by key for the lifetime of the JS context, deduping
 * concurrent callers. A rejected promise is evicted so a later call can retry.
 */
function memoizeByKey<T>(store: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit) return hit;
  const p = fn().catch((err) => {
    store.delete(key);
    throw err;
  });
  store.set(key, p);
  return p;
}

// Hetzner's server-type catalog and datacenter availability are region-agnostic
// and change rarely, so fetch each once per token and reuse across region
// switches. Keyed by token; refreshed on a new page load.
const hetznerSizeCache = new Map<string, Promise<HetznerSize[]>>();
const hetznerAvailCache = new Map<string, Promise<Map<string, Set<number>>>>();

/** Non-deprecated server types (deprecated ones are dropped as un-orderable). */
function fetchHetznerSizes(exec: ExecFn, token: string): Promise<HetznerSize[]> {
  return memoizeByKey(hetznerSizeCache, token, async () => {
    const rows: HetznerSize[] = [];
    let url: string | null = "https://api.hetzner.cloud/v1/server_types?per_page=50";
    for (let guard = 0; url && guard < 10; guard++) {
      const res = await call(exec, { method: "GET", url, headers: bearer(token) });
      if (res.status >= 300) throw new Error(providerError(res, "list server types"));
      const types = Array.isArray(res.body?.server_types) ? res.body.server_types : [];
      for (const t of types) {
        if (t.deprecation) continue; // globally deprecated — no longer orderable
        const arch = t.architecture === "arm" ? "Arm64" : "x86";
        rows.push({
          typeId: Number(t.id),
          id: String(t.name),
          label: `${t.name} · ${t.cores} vCPU · ${t.memory} GB · ${t.disk} GB (${arch})`,
          cores: Number(t.cores) || 0,
          memory: Number(t.memory) || 0,
          pricePerHour: hetznerHourlyPrice(t),
        });
      }
      const next = res.body?.meta?.pagination?.next_page;
      url = next ? `https://api.hetzner.cloud/v1/server_types?per_page=50&page=${next}` : null;
    }
    return rows;
  });
}

/** Map of region (location name) → server-type ids orderable there right now. */
function fetchHetznerAvailability(exec: ExecFn, token: string): Promise<Map<string, Set<number>>> {
  return memoizeByKey(hetznerAvailCache, token, async () => {
    const byRegion = new Map<string, Set<number>>();
    let url: string | null = "https://api.hetzner.cloud/v1/datacenters?per_page=50";
    for (let guard = 0; url && guard < 10; guard++) {
      const res = await call(exec, { method: "GET", url, headers: bearer(token) });
      if (res.status >= 300) throw new Error(providerError(res, "list datacenters"));
      const dcs = Array.isArray(res.body?.datacenters) ? res.body.datacenters : [];
      for (const dc of dcs) {
        const region = dc?.location?.name;
        if (!region) continue;
        const set = byRegion.get(region) ?? new Set<number>();
        const avail = Array.isArray(dc?.server_types?.available) ? dc.server_types.available : [];
        for (const id of avail) set.add(Number(id));
        byRegion.set(region, set);
      }
      const next = res.body?.meta?.pagination?.next_page;
      url = next ? `https://api.hetzner.cloud/v1/datacenters?per_page=50&page=${next}` : null;
    }
    return byRegion;
  });
}

const hetzner: ProviderAdapter = {
  id: "hetzner",
  name: "Hetzner Cloud",
  currency: "EUR",
  regions: [
    { id: "nbg1", label: "Nuremberg" },
    { id: "fsn1", label: "Falkenstein" },
    { id: "hel1", label: "Helsinki" },
    { id: "ash", label: "Ashburn, VA" },
    { id: "hil", label: "Hillsboro, OR" },
  ],
  defaultRegion: "nbg1",
  // Only currently-orderable shared plans. The shared-Intel `cx` line (e.g.
  // cx22 = type id 104) was deprecated on 2026-01-01 and is intentionally
  // omitted — ordering it returns HTTP 422. cpx = AMD x86, cax = Arm64.
  // Prices are indicative hourly gross (EUR) for the cost hint; the live
  // `listSizes` fetch below overrides them with the token's real prices.
  sizes: [
    { id: "cpx11", label: "cpx11 · 2 vCPU · 2 GB · 40 GB (AMD x86)", pricePerHour: 0.007 },
    { id: "cpx21", label: "cpx21 · 3 vCPU · 4 GB · 80 GB (AMD x86)", pricePerHour: 0.013 },
    { id: "cpx31", label: "cpx31 · 4 vCPU · 8 GB · 160 GB (AMD x86)", pricePerHour: 0.026 },
    { id: "cpx41", label: "cpx41 · 8 vCPU · 16 GB · 240 GB (AMD x86)", pricePerHour: 0.049 },
    { id: "cpx51", label: "cpx51 · 16 vCPU · 32 GB · 360 GB (AMD x86)", pricePerHour: 0.099 },
    { id: "cax11", label: "cax11 · 2 vCPU · 4 GB · 40 GB (Arm64)", pricePerHour: 0.006 },
    { id: "cax21", label: "cax21 · 4 vCPU · 8 GB · 80 GB (Arm64)", pricePerHour: 0.012 },
    { id: "cax31", label: "cax31 · 8 vCPU · 16 GB · 160 GB (Arm64)", pricePerHour: 0.024 },
    { id: "cax41", label: "cax41 · 16 vCPU · 32 GB · 320 GB (Arm64)", pricePerHour: 0.048 },
  ],
  // x86, 4 GB — closest drop-in for the retired cx22, and x86 avoids the
  // Arm-compat pitfalls of the cax line for Docker images and binaries.
  defaultSize: "cpx21",
  // `shutdown -h now` only powers a Hetzner server off; billing continues until
  // the API resource is deleted. Hosted reconciliation supplies that authority.
  guestCanEnsureDeletion: false,
  async validateToken({ exec, token }) {
    const res = await call(exec, {
      method: "GET",
      url: "https://api.hetzner.cloud/v1/servers?per_page=1",
      headers: bearer(token),
    });
    if (res.status >= 300) throw new Error(providerError(res, "validate credential"));
  },
  async listSizes({ exec, token, region }) {
    // Live catalog minus anything Hetzner has deprecated (both memoized per
    // token, so switching region doesn't re-fetch).
    const rows = await fetchHetznerSizes(exec, token);
    // Narrow to what the chosen region can actually order — a plan can be
    // globally live yet unavailable in a given datacenter. Best-effort: if the
    // lookup fails or matches nothing, keep the un-narrowed list.
    let scoped = rows;
    if (region) {
      try {
        const set = (await fetchHetznerAvailability(exec, token)).get(region);
        const filtered = set ? rows.filter((r) => set.has(r.typeId)) : rows;
        if (filtered.length) scoped = filtered;
      } catch {
        // keep the un-narrowed live list rather than dropping to the static one
      }
    }
    return [...scoped]
      .sort((a, b) => a.cores - b.cores || a.memory - b.memory || a.id.localeCompare(b.id))
      .map(({ id, label, pricePerHour }) => ({ id, label, pricePerHour }));
  },
  async provision({ exec, token, config, userData }) {
    const name = `bivy-${config.slug}`;
    // Hetzner has no create idempotency token. The stable attempt label is the
    // recovery key: after a timeout, a retry adopts the accepted server instead
    // of issuing another paid create.
    if (config.attemptId) {
      const found = await call(exec, {
        method: "GET",
        url: `https://api.hetzner.cloud/v1/servers?label_selector=${encodeURIComponent(`bivy-attempt=${config.attemptId}`)}`,
        headers: bearer(token),
      });
      if (found.status < 300 && Array.isArray(found.body?.servers) && found.body.servers[0]) {
        const s = found.body.servers[0];
        return { id: String(s.id), provider: "hetzner", name, region: config.region || "nbg1", status: mapHetznerStatus(s.status), ip: s.public_net?.ipv4?.ip || null, createdAt: nowIso(), ttlMinutes: config.ttlMinutes };
      }
    }
    const res = await call(exec, {
      method: "POST",
      url: "https://api.hetzner.cloud/v1/servers",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: {
        name,
        server_type: config.size || hetzner.defaultSize,
        image: config.image || "ubuntu-24.04",
        location: config.region || "nbg1",
        user_data: userData,
        start_after_create: true,
        labels: {
          bivy: "ephemeral",
          ...(config.attemptId ? { "bivy-attempt": String(config.attemptId) } : {}),
          ...(config.ownershipTag ? { "bivy-account": String(config.ownershipTag) } : {}),
        },
      },
    });
    if (res.status >= 300) throw new Error(providerError(res, "create server"));
    const s = res.body && res.body.server;
    if (!s) throw new Error("Hetzner did not return a server");
    return {
      id: String(s.id),
      provider: "hetzner",
      name,
      region: config.region || "nbg1",
      status: mapHetznerStatus(s.status),
      ip: s.public_net?.ipv4?.ip || null,
      createdAt: nowIso(),
      ttlMinutes: config.ttlMinutes,
    };
  },
  async status({ exec, token, machine }) {
    const res = await call(exec, {
      method: "GET",
      url: `https://api.hetzner.cloud/v1/servers/${encodeURIComponent(machine.id)}`,
      headers: bearer(token),
    });
    if (res.status === 404) return "gone";
    if (res.status >= 300) throw new Error(providerError(res, "get server"));
    return mapHetznerStatus(res.body?.server?.status);
  },
  async destroy({ exec, token, machine }) {
    const res = await call(exec, {
      method: "DELETE",
      url: `https://api.hetzner.cloud/v1/servers/${encodeURIComponent(machine.id)}`,
      headers: bearer(token),
    });
    if (res.status >= 300 && res.status !== 404) throw new Error(providerError(res, "delete server"));
  },
  async discover({ exec, token, ownershipTag }) {
    const res = await call(exec, {
      method: "GET",
      url: `https://api.hetzner.cloud/v1/servers?label_selector=${encodeURIComponent(`bivy-account=${ownershipTag}`)}`,
      headers: bearer(token),
    });
    if (res.status >= 300) throw new Error(providerError(res, "list servers"));
    const servers = Array.isArray(res.body?.servers) ? res.body.servers : [];
    return servers.map((s: any): EphemeralMachine => ({
      id: String(s.id),
      provider: "hetzner",
      name: String(s.name || ""),
      region: s.datacenter?.location?.name || "",
      status: mapHetznerStatus(s.status),
      ip: s.public_net?.ipv4?.ip || null,
      createdAt: typeof s.created === "string" ? s.created : "",
      attemptId: typeof s.labels?.["bivy-attempt"] === "string" ? s.labels["bivy-attempt"] : undefined,
    }));
  },
};

// Maps a Fly size id to the guest spec sent in the machine config.
const FLY_GUEST: Record<string, { cpus: number; memoryMb: number }> = {
  "shared-1x-1gb": { cpus: 1, memoryMb: 1024 },
  "shared-1x-2gb": { cpus: 1, memoryMb: 2048 },
  "shared-2x-4gb": { cpus: 2, memoryMb: 4096 },
  "shared-4x-8gb": { cpus: 4, memoryMb: 8192 },
};

/** Build the Fly Machine `config` fragment (`files` + `init.exec`) that boots a
 *  headless, pre-enrolled Bivy node. Fly can't run the shared cloud-init
 *  user_data (see the note in `fly.provision`), so the relay.json + start.sh are
 *  written as `files` and the daemon is launched as a blocking foreground init
 *  process. `raw_value` is base64 per the Machines API; `start.sh` is invoked via
 *  `bash <path>` so it needs no execute bit. */
function flyInit(opts: BootstrapOpts): {
  files: { guest_path: string; raw_value: string }[];
  init: { exec: string[] };
} {
  const installUrl = opts.installUrl || "https://bivy.sh/install.sh";
  const ttlSeconds = clampTtlMinutes(opts.ttlMinutes) * 60;
  const b64text = (s: string) => b64(utf8.encode(s));
  // Unlike the VM providers' cloud images, Fly's bare `ubuntu:24.04` OCI image
  // ships neither cloud-init NOR curl — so we install curl/ca-certificates
  // ourselves before fetching the installer (otherwise `curl | bash` fails with
  // "curl: command not found"). `set -euo pipefail` makes any step failing abort
  // the whole boot loudly instead of silently limping on to a doomed
  // `bivy start` — a failed boot then exits, and `auto_destroy` reaps the
  // machine so it's visible as gone rather than a silent zombie.
  const initScript = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "mkdir -p /etc/bivy",
    "export BIVY_DATA_DIR=/etc/bivy",
    `command -v bivy >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq curl ca-certificates; curl -fsSL ${shq(installUrl)} | bash; }`,
    // Hand the foreground to the daemon under a TTL `timeout` — the backstop
    // that replaces the VM's `shutdown -h now`. When it fires (or the agent
    // finishes) the process exits and `auto_destroy` removes the machine.
    `exec timeout ${ttlSeconds} bash /etc/bivy/start.sh`,
  ].join("\n");
  return {
    files: [
      { guest_path: "/etc/bivy/relay.json", raw_value: b64text(bivyRelayJson(opts)) },
      { guest_path: "/etc/bivy/start.sh", raw_value: b64text(bivyStartScript(opts)) },
    ],
    init: { exec: ["/bin/bash", "-lc", initScript] },
  };
}

const fly: ProviderAdapter = {
  id: "fly",
  name: "Fly.io",
  currency: "USD",
  regions: [
    { id: "iad", label: "Ashburn, VA" },
    { id: "sjc", label: "San Jose" },
    { id: "lhr", label: "London" },
    { id: "fra", label: "Frankfurt" },
    { id: "syd", label: "Sydney" },
    { id: "nrt", label: "Tokyo" },
  ],
  defaultRegion: "iad",
  // Indicative on-demand price/hour (USD) for the cost hint: Fly's shared-cpu
  // compute plus the extra RAM. Fly bills per second while the machine runs.
  sizes: [
    { id: "shared-1x-1gb", label: "shared · 1 vCPU · 1 GB", pricePerHour: 0.009 },
    { id: "shared-1x-2gb", label: "shared · 1 vCPU · 2 GB", pricePerHour: 0.0136 },
    { id: "shared-2x-4gb", label: "shared · 2 vCPU · 4 GB", pricePerHour: 0.0273 },
    { id: "shared-4x-8gb", label: "shared · 4 vCPU · 8 GB", pricePerHour: 0.0546 },
  ],
  defaultSize: "shared-1x-2gb",
  async validateToken({ exec, token }) {
    const res = await call(exec, {
      method: "GET",
      url: "https://api.machines.dev/v1/apps",
      headers: bearer(token),
    });
    if (res.status >= 300) throw new Error(providerError(res, "validate credential"));
  },
  async provision({ exec, token, config, userData, bootstrap }) {
    const app = `bivy-${config.slug}`;
    const org = config.org || "personal";
    const guest = FLY_GUEST[config.size as string] || FLY_GUEST[fly.defaultSize] || { cpus: 1, memoryMb: 2048 };
    const created = await call(exec, {
      method: "POST",
      url: "https://api.machines.dev/v1/apps",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: { app_name: app, org_slug: org },
    });
    if (created.status >= 300 && created.status !== 409) throw new Error(providerError(created, "create app"));
    // Fly app creation is naturally name-idempotent, but machine creation is
    // not. Adopt a machine carrying this attempt metadata before retrying create.
    if (config.attemptId) {
      const found = await call(exec, {
        method: "GET",
        url: `https://api.machines.dev/v1/apps/${encodeURIComponent(app)}/machines`,
        headers: bearer(token),
      });
      const existing = Array.isArray(found.body) ? found.body.find((m: any) => m?.config?.metadata?.["bivy-attempt"] === String(config.attemptId)) : null;
      if (found.status < 300 && existing?.id) {
        return { id: String(existing.id), provider: "fly", app, name: app, region: existing.region || config.region || "iad", status: mapFlyStatus(existing.state), ip: null, createdAt: nowIso(), ttlMinutes: config.ttlMinutes };
      }
    }
    // A Fly Machine is an OCI image in a Firecracker microVM, NOT a cloud-init
    // VM: the `#cloud-config` user_data the other providers use is never
    // executed, and a bare `ubuntu:24.04` just runs `/bin/bash`, which exits
    // immediately — so with `restart: no` + `auto_destroy` the machine boots and
    // self-destructs before it ever installs Bivy (that's the "app has no
    // machines" / node-offline symptom). Instead we materialize the same
    // relay.json + start.sh via `files` and run them ourselves as a blocking
    // foreground init process. `auto_destroy` tears the machine down when the
    // daemon exits. The daemon's quiet-state teardown snapshots completed work
    // and exits after `agent_end`, so this no longer depends on a watching
    // device; the TTL `timeout` remains an independent hard backstop. Falls back
    // to user_data only if no structured bootstrap is given.
    const machineInit = bootstrap ? flyInit(bootstrap) : { init: { user_data: userData } };
    const machine = await call(exec, {
      method: "POST",
      url: `https://api.machines.dev/v1/apps/${encodeURIComponent(app)}/machines`,
      headers: { ...bearer(token), "content-type": "application/json" },
      body: {
        region: config.region || "iad",
        config: {
          image: config.image || "ubuntu:24.04",
          // DEBUG: when keeping failed machines, don't auto-destroy — a boot
          // failure then stops the machine (logs retained) instead of vanishing.
          auto_destroy: bootstrap?.debugKeepMachine ? false : true,
          restart: { policy: "no" },
          guest: { cpu_kind: "shared", cpus: Number(config.cpus) || guest.cpus, memory_mb: Number(config.memoryMb) || guest.memoryMb },
          metadata: {
            bivy: "ephemeral",
            ...(config.attemptId ? { "bivy-attempt": String(config.attemptId) } : {}),
            ...(config.ownershipTag ? { "bivy-account": String(config.ownershipTag) } : {}),
          },
          ...machineInit,
        },
      },
    });
    if (machine.status >= 300) throw new Error(providerError(machine, "create machine"));
    const m = machine.body;
    if (!m || !m.id) throw new Error("Fly did not return a machine");
    return {
      id: String(m.id),
      provider: "fly",
      app,
      name: app,
      region: config.region || "iad",
      status: mapFlyStatus(m.state),
      ip: null,
      createdAt: nowIso(),
      ttlMinutes: config.ttlMinutes,
    };
  },
  async status({ exec, token, machine }) {
    const res = await call(exec, {
      method: "GET",
      url: `https://api.machines.dev/v1/apps/${encodeURIComponent(machine.app || "")}/machines/${encodeURIComponent(machine.id)}`,
      headers: bearer(token),
    });
    if (res.status === 404) return "gone";
    if (res.status >= 300) throw new Error(providerError(res, "get machine"));
    return mapFlyStatus(res.body?.state);
  },
  async destroy({ exec, token, machine }) {
    const res = await call(exec, {
      method: "DELETE",
      url: `https://api.machines.dev/v1/apps/${encodeURIComponent(machine.app || "")}/machines/${encodeURIComponent(machine.id)}?force=true`,
      headers: bearer(token),
    });
    if (res.status >= 300 && res.status !== 404) throw new Error(providerError(res, "delete machine"));
  },
  // Fly has no account-wide "list machines by tag" call — a Machine is scoped
  // to its app. Discovery instead lists every `bivy-`-prefixed app reachable
  // with this token and checks each one's machines for the ownership tag.
  // Bounded by how many bivy- apps exist for the token (normally very few);
  // one app's list call failing is skipped rather than aborting the scan.
  async discover({ exec, token, ownershipTag }) {
    const appsRes = await call(exec, { method: "GET", url: "https://api.machines.dev/v1/apps", headers: bearer(token) });
    if (appsRes.status >= 300) throw new Error(providerError(appsRes, "list apps"));
    const apps: any[] = Array.isArray(appsRes.body?.apps) ? appsRes.body.apps : Array.isArray(appsRes.body) ? appsRes.body : [];
    const found: EphemeralMachine[] = [];
    for (const a of apps) {
      const name = String(a?.name || "");
      if (!name.startsWith("bivy-")) continue;
      const res = await call(exec, { method: "GET", url: `https://api.machines.dev/v1/apps/${encodeURIComponent(name)}/machines`, headers: bearer(token) });
      if (res.status >= 300) continue;
      const machines: any[] = Array.isArray(res.body) ? res.body : [];
      for (const m of machines) {
        const meta = m?.config?.metadata || {};
        if (meta.bivy !== "ephemeral" || meta["bivy-account"] !== ownershipTag) continue;
        found.push({
          id: String(m.id),
          provider: "fly",
          app: name,
          name,
          region: m.region || "",
          status: mapFlyStatus(m.state),
          ip: null,
          createdAt: typeof m.created_at === "string" ? m.created_at : "",
          attemptId: typeof meta["bivy-attempt"] === "string" ? meta["bivy-attempt"] : undefined,
        });
      }
    }
    return found;
  },
};

// --- AWS: SigV4 signing + a minimal EC2 Query/XML client -------------------
//
// AWS has no bearer-token API: every request is authenticated by deriving an
// HMAC-SHA256 signature from the caller's access key + secret key (SigV4).
// Unlike Fly/Hetzner, that means the *adapter itself* signs each request
// before handing it to the allowlisted ExecFn — the exec proxy stays a dumb
// forwarder either way; it just now receives a fully pre-signed request, so
// no other call site needs to know AWS auth even exists. Implemented with
// only Web Crypto (crypto.subtle) so @bivy/core keeps zero runtime
// dependencies, and verified against AWS's own published SigV4 test vectors
// (see test/ephemeral-aws.test.ts).
//
// EC2 itself only speaks the legacy "Query" protocol — form-encoded request,
// XML response — there is no JSON protocol for EC2 (that exists for some
// newer AWS APIs, but not this one), so a tiny dependency-free XML reader is
// included below. Systems Manager (used only to resolve the current Ubuntu
// AMI id) speaks AWS's JSON protocol instead, which is why `awsSsmGetParameter`
// looks different from `awsEc2Call`.

export interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** AWS needs two secrets, not one (plus an optional session token for STS
 *  credentials) — pasted as `accessKeyId:secretAccessKey[:sessionToken]`.
 *  The token field itself stays an opaque string as far as the shared
 *  store/UI are concerned (see `EphemeralKeyStore`), so this parsing lives
 *  entirely inside the adapter and no call site needs to change to support a
 *  multi-part credential. */
export function parseAwsToken(token: string): AwsCreds {
  const parts = String(token || "").split(":");
  const accessKeyId = (parts[0] || "").trim();
  const secretAccessKey = (parts[1] || "").trim();
  const sessionToken = parts.length > 2 ? parts.slice(2).join(":").trim() || undefined : undefined;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS token must be `accessKeyId:secretAccessKey` (optionally `:sessionToken`)");
  }
  return { accessKeyId, secretAccessKey, sessionToken };
}

const utf8 = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? utf8.encode(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, utf8.encode(data)));
}

/** AWS's URI-encoding rule is RFC 3986 unreserved characters left bare and
 *  everything else percent-encoded with UPPERCASE hex. `encodeURIComponent`
 *  gets almost all of it right but leaves `! * ' ( )` unencoded, which SigV4
 *  requires encoded — AWS explicitly warns platform URI-encoders aren't safe
 *  to use as-is for this reason. */
function awsUriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function amzDateNow(): string {
  try {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  } catch {
    return "19700101T000000Z";
  }
}

/**
 * Sign one AWS request (SigV4) and return the headers to send, including
 * `authorization`. Canonical query string is always empty here — every AWS
 * call this adapter makes is a POST with the request in the body, so there's
 * nothing to canonicalize there. Verified against AWS's published
 * `get-vanilla`/`post-vanilla` SigV4 test vectors in test/ephemeral-aws.test.ts.
 */
export async function awsSign(args: {
  method: string;
  host: string;
  path: string;
  region: string;
  service: string;
  headers: Record<string, string>;
  body: string;
  creds: AwsCreds;
  amzDate?: string;
}): Promise<Record<string, string>> {
  const amzDate = args.amzDate || amzDateNow();
  const dateStamp = amzDate.slice(0, 8);
  const toSign: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.headers)) toSign[k.toLowerCase()] = v;
  toSign.host = args.host;
  toSign["x-amz-date"] = amzDate;
  if (args.creds.sessionToken) toSign["x-amz-security-token"] = args.creds.sessionToken;

  const signedHeaderNames = Object.keys(toSign).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${String(toSign[k]).trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const payloadHash = await sha256Hex(args.body);
  const canonicalRequest = [args.method.toUpperCase(), args.path || "/", "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${args.region}/${args.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256Hex(canonicalRequest)].join("\n");

  const kDate = await hmacSha256(utf8.encode(`AWS4${args.creds.secretAccessKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, args.region);
  const kService = await hmacSha256(kRegion, args.service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  return {
    ...toSign,
    authorization: `AWS4-HMAC-SHA256 Credential=${args.creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// --- tiny dependency-free XML reader (just enough for EC2 Query responses) -

export interface XmlEl {
  tag: string;
  children: XmlEl[];
  text: string;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

/** Recursive-descent parse of a well-formed XML document into a plain tree.
 *  Handles nested elements, attributes (discarded — EC2 responses don't put
 *  data we need in them), self-closing tags, comments, and the `<?xml?>`
 *  prolog. This is not a general-purpose XML parser — just enough for AWS's
 *  Query-protocol response shape, to avoid a real XML dependency for the one
 *  provider that needs it. */
export function parseXml(xml: string): XmlEl {
  let i = 0;
  const n = xml.length;
  const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
  function skipSpace() {
    while (i < n && isSpace(xml.charAt(i))) i++;
  }
  function skipMisc() {
    for (;;) {
      skipSpace();
      if (xml.startsWith("<?", i)) {
        const end = xml.indexOf("?>", i);
        i = end < 0 ? n : end + 2;
        continue;
      }
      if (xml.startsWith("<!--", i)) {
        const end = xml.indexOf("-->", i);
        i = end < 0 ? n : end + 3;
        continue;
      }
      if (xml.startsWith("<!", i)) {
        const end = xml.indexOf(">", i);
        i = end < 0 ? n : end + 1;
        continue;
      }
      break;
    }
  }
  function readName(): string {
    const start = i;
    while (i < n && !isSpace(xml.charAt(i)) && xml.charAt(i) !== ">" && xml.charAt(i) !== "/" && xml.charAt(i) !== "=") i++;
    return xml.slice(start, i);
  }
  function skipAttrs() {
    for (;;) {
      skipSpace();
      if (i >= n || xml.charAt(i) === ">" || xml.charAt(i) === "/") return;
      readName(); // attribute name — discarded
      skipSpace();
      if (xml.charAt(i) === "=") {
        i++;
        skipSpace();
        const quote = xml.charAt(i);
        if (quote === '"' || quote === "'") {
          i++;
          const end = xml.indexOf(quote, i);
          i = end < 0 ? n : end + 1;
        } else {
          while (i < n && !isSpace(xml.charAt(i)) && xml.charAt(i) !== ">") i++;
        }
      }
    }
  }
  function parseElement(): XmlEl {
    i++; // '<'
    const tag = readName();
    skipAttrs();
    skipSpace();
    const el: XmlEl = { tag, children: [], text: "" };
    if (xml.charAt(i) === "/") {
      i += 2; // '/>'
      return el;
    }
    i++; // '>'
    let text = "";
    while (i < n) {
      if (xml.startsWith("</", i)) {
        const end = xml.indexOf(">", i);
        i = end < 0 ? n : end + 1;
        break;
      }
      if (xml.startsWith("<!--", i)) {
        const end = xml.indexOf("-->", i);
        i = end < 0 ? n : end + 3;
        continue;
      }
      if (xml.charAt(i) === "<") {
        el.children.push(parseElement());
        continue;
      }
      const start = i;
      while (i < n && xml.charAt(i) !== "<") i++;
      text += xml.slice(start, i);
    }
    el.text = decodeXmlEntities(text).trim();
    return el;
  }
  skipMisc();
  if (i >= n || xml.charAt(i) !== "<") return { tag: "", children: [], text: "" };
  return parseElement();
}

export function xmlChild(el: XmlEl | undefined, tag: string): XmlEl | undefined {
  return el?.children.find((c) => c.tag === tag);
}
export function xmlChildren(el: XmlEl | undefined, tag: string): XmlEl[] {
  return el ? el.children.filter((c) => c.tag === tag) : [];
}
/** Depth-first search for the first descendant with this tag, anywhere in the
 *  subtree — used to pull error codes/messages and single-instance fields out
 *  of AWS's responses without depending on their exact nesting depth. */
export function xmlFind(el: XmlEl | undefined, tag: string): XmlEl | undefined {
  if (!el) return undefined;
  if (el.tag === tag) return el;
  for (const c of el.children) {
    const hit = xmlFind(c, tag);
    if (hit) return hit;
  }
  return undefined;
}

function awsFormBody(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`)
    .join("&");
}

function ec2Host(region: string): string {
  return `ec2.${region}.amazonaws.com`;
}
function ssmHost(region: string): string {
  return `ssm.${region}.amazonaws.com`;
}

/** One signed EC2 Query-protocol call. Returns the parsed XML root and throws
 *  with the provider's own error code/message on failure. */
async function awsEc2Call(
  exec: ExecFn,
  creds: AwsCreds,
  region: string,
  action: string,
  params: Record<string, string | undefined>,
  actionLabel: string,
): Promise<XmlEl> {
  const host = ec2Host(region);
  const body = awsFormBody({ Action: action, Version: "2016-11-15", ...params });
  const headers = await awsSign({
    method: "POST",
    host,
    path: "/",
    region,
    service: "ec2",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body,
    creds,
  });
  const res = await call(exec, { method: "POST", url: `https://${host}/`, headers, body });
  const xml = typeof res.body === "string" && res.body.trim() ? parseXml(res.body) : { tag: "", children: [], text: "" };
  if (res.status >= 300) {
    const code = xmlFind(xml, "Code")?.text;
    const message = xmlFind(xml, "Message")?.text;
    throw new Error(`AWS failed to ${actionLabel} (HTTP ${res.status}${code ? `: ${code}` : ""}${message ? ` — ${message}` : ""})`);
  }
  return xml;
}

/** One signed SSM (JSON protocol) call — only used to resolve the current
 *  Ubuntu AMI id via a Canonical-published public parameter. */
async function awsSsmGetParameter(exec: ExecFn, creds: AwsCreds, region: string, name: string): Promise<string> {
  const host = ssmHost(region);
  const body = JSON.stringify({ Name: name });
  const headers = await awsSign({
    method: "POST",
    host,
    path: "/",
    region,
    service: "ssm",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AmazonSSM.GetParameter" },
    body,
    creds,
  });
  const res = await call(exec, { method: "POST", url: `https://${host}/`, headers, body });
  if (res.status >= 300) {
    const msg = extractProviderMessage(res.body) || (res.body && typeof res.body === "object" ? String((res.body as any).__type ?? "") : "");
    throw new Error(`AWS failed to resolve the Ubuntu AMI (HTTP ${res.status}${msg ? `: ${msg}` : ""})`);
  }
  const value = res.body && typeof res.body === "object" ? (res.body as any)?.Parameter?.Value : undefined;
  if (!value) throw new Error("AWS SSM did not return an AMI id");
  return String(value);
}

// Canonical publishes the current Ubuntu 24.04 (Noble) amd64 AMI id per
// region as a public SSM parameter, so we always launch the latest image
// instead of a hardcoded id that eventually goes stale. Memoized per region
// (the value doesn't depend on which account looks it up) for the lifetime of
// the JS context, same pattern as Hetzner's server-type cache below.
const AWS_UBUNTU_AMI_PARAM = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id";
const awsAmiCache = new Map<string, Promise<string>>();
function resolveUbuntuAmi(exec: ExecFn, creds: AwsCreds, region: string): Promise<string> {
  return memoizeByKey(awsAmiCache, region, () => awsSsmGetParameter(exec, creds, region, AWS_UBUNTU_AMI_PARAM));
}

function mapAwsStatus(name: string | undefined): string {
  switch (name) {
    case "running":
      return "running";
    case "pending":
      return "starting";
    case "stopping":
    case "stopped":
    case "shutting-down":
      return "stopped";
    case "terminated":
      return "gone";
    default:
      return "starting";
  }
}

const AWS_REGIONS = [
  { id: "us-east-1", label: "US East (N. Virginia)" },
  { id: "us-west-2", label: "US West (Oregon)" },
  { id: "eu-west-1", label: "Europe (Ireland)" },
  { id: "eu-central-1", label: "Europe (Frankfurt)" },
  { id: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
  { id: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
];

// A curated, x86_64 (amd64) subset of EC2's general-purpose "T" burstable
// family — matches the Ubuntu amd64 AMI resolved via SSM above. `listSizes`
// narrows this to whatever DescribeInstanceTypes confirms is actually
// orderable in the chosen region, same live-catalog pattern as Hetzner.
// Indicative on-demand price/hour (USD, us-east-1) for the cost hint. Real
// price varies by region; this is close enough for an at-a-glance estimate.
const AWS_SIZES: ProviderSize[] = [
  { id: "t3.micro", label: "t3.micro · 2 vCPU · 1 GB", pricePerHour: 0.0104 },
  { id: "t3.small", label: "t3.small · 2 vCPU · 2 GB", pricePerHour: 0.0208 },
  { id: "t3.medium", label: "t3.medium · 2 vCPU · 4 GB", pricePerHour: 0.0416 },
  { id: "t3.large", label: "t3.large · 2 vCPU · 8 GB", pricePerHour: 0.0832 },
  { id: "t3.xlarge", label: "t3.xlarge · 4 vCPU · 16 GB", pricePerHour: 0.1664 },
  { id: "t3.2xlarge", label: "t3.2xlarge · 8 vCPU · 32 GB", pricePerHour: 0.3328 },
];

const aws: ProviderAdapter = {
  id: "aws",
  name: "AWS EC2",
  currency: "USD",
  regions: AWS_REGIONS,
  defaultRegion: "us-east-1",
  sizes: AWS_SIZES,
  defaultSize: "t3.medium",
  async validateToken({ exec, token, region }) {
    const creds = parseAwsToken(token);
    await awsEc2Call(exec, creds, region || aws.defaultRegion, "DescribeInstances", { MaxResults: "5" }, "validate credential");
  },
  async listSizes({ exec, token, region }) {
    const creds = parseAwsToken(token);
    const reg = region || aws.defaultRegion;
    const params: Record<string, string> = {};
    AWS_SIZES.forEach((s, idx) => {
      params[`InstanceType.${idx + 1}`] = s.id;
    });
    let xml: XmlEl;
    try {
      xml = await awsEc2Call(exec, creds, reg, "DescribeInstanceTypes", params, "list instance types");
    } catch {
      return AWS_SIZES; // best-effort — keep the static list rather than failing the picker
    }
    const rows = xmlChildren(xmlChild(xml, "instanceTypeSet"), "item")
      .map((item): ProviderSize | null => {
        const id = xmlChild(item, "instanceType")?.text || "";
        const vcpus = xmlChild(xmlChild(item, "vCpuInfo"), "defaultVCpus")?.text;
        const memMib = xmlChild(xmlChild(item, "memoryInfo"), "sizeInMiB")?.text;
        const gb = memMib ? Math.round(Number(memMib) / 1024) : undefined;
        // EC2's DescribeInstanceTypes carries no pricing, so carry the static
        // indicative price across by instance-type id for the cost hint.
        const pricePerHour = AWS_SIZES.find((s) => s.id === id)?.pricePerHour;
        return id ? { id, label: `${id} · ${vcpus ?? "?"} vCPU · ${gb ?? "?"} GB`, pricePerHour } : null;
      })
      .filter((r): r is ProviderSize => Boolean(r));
    return rows.length ? rows : AWS_SIZES;
  },
  async provision({ exec, token, config, userData }) {
    const creds = parseAwsToken(token);
    const region = config.region || aws.defaultRegion;
    const name = `bivy-${config.slug}`;
    const amiId = config.image ? String(config.image) : await resolveUbuntuAmi(exec, creds, region);
    const xml = await awsEc2Call(
      exec,
      creds,
      region,
      "RunInstances",
      {
        ImageId: amiId,
        InstanceType: config.size || aws.defaultSize,
        MinCount: "1",
        MaxCount: "1",
        UserData: b64(utf8.encode(userData)),
        InstanceInitiatedShutdownBehavior: "terminate",
        // EC2 makes RunInstances idempotent for this token. A retry after a
        // timeout returns the original instance rather than billing for another.
        ...(config.attemptId ? { ClientToken: String(config.attemptId) } : {}),
        "TagSpecification.1.ResourceType": "instance",
        "TagSpecification.1.Tag.1.Key": "Name",
        "TagSpecification.1.Tag.1.Value": name,
        "TagSpecification.1.Tag.2.Key": "bivy",
        "TagSpecification.1.Tag.2.Value": "ephemeral",
        ...(config.attemptId ? {
          "TagSpecification.1.Tag.3.Key": "bivy-attempt",
          "TagSpecification.1.Tag.3.Value": String(config.attemptId),
        } : {}),
        ...(config.ownershipTag ? {
          "TagSpecification.1.Tag.4.Key": "bivy-account",
          "TagSpecification.1.Tag.4.Value": String(config.ownershipTag),
        } : {}),
      },
      "launch instance",
    );
    const item = xmlChild(xmlChild(xml, "instancesSet"), "item");
    const instanceId = xmlChild(item, "instanceId")?.text;
    if (!instanceId) throw new Error("AWS did not return an instance id");
    const stateName = xmlChild(xmlChild(item, "instanceState"), "name")?.text;
    // A public IP is usually assigned immediately when launching into a
    // default VPC/subnet, but isn't guaranteed at RunInstances time — status()
    // picks it up on the next poll if it's missing here, same as Fly.
    const ip = xmlChild(item, "ipAddress")?.text || xmlFind(xmlChild(item, "networkInterfaceSet"), "publicIp")?.text || null;
    return {
      id: instanceId,
      provider: "aws",
      name,
      region,
      status: mapAwsStatus(stateName),
      ip: ip || null,
      createdAt: nowIso(),
      ttlMinutes: config.ttlMinutes,
    };
  },
  async status({ exec, token, machine }) {
    const creds = parseAwsToken(token);
    let xml: XmlEl;
    try {
      xml = await awsEc2Call(exec, creds, machine.region, "DescribeInstances", { "InstanceId.1": machine.id }, "get instance");
    } catch (err) {
      if (String((err as Error).message || "").includes("InvalidInstanceID.NotFound")) return "gone";
      throw err;
    }
    const item = xmlChild(xmlFind(xml, "instancesSet"), "item");
    if (!item) return "gone";
    return mapAwsStatus(xmlChild(xmlChild(item, "instanceState"), "name")?.text);
  },
  async destroy({ exec, token, machine }) {
    const creds = parseAwsToken(token);
    try {
      await awsEc2Call(exec, creds, machine.region, "TerminateInstances", { "InstanceId.1": machine.id }, "terminate instance");
    } catch (err) {
      if (!String((err as Error).message || "").includes("InvalidInstanceID.NotFound")) throw err;
    }
  },
  // EC2 has no cross-region "list by tag" call — a DescribeInstances Filter is
  // always scoped to the region it's sent to. Scanning the whole curated
  // region list keeps this correct even if an account's config region ever
  // changed; it's bounded (six regions) and this only runs on the slow,
  // infrequent orphan-sweep cadence, not the fast convergence loop. One
  // region failing (e.g. not opted into that region) is skipped, not fatal.
  async discover({ exec, token, ownershipTag }) {
    const creds = parseAwsToken(token);
    const found: EphemeralMachine[] = [];
    for (const region of AWS_REGIONS.map((r) => r.id)) {
      let xml: XmlEl;
      try {
        xml = await awsEc2Call(
          exec,
          creds,
          region,
          "DescribeInstances",
          {
            "Filter.1.Name": "tag:bivy-account",
            "Filter.1.Value.1": ownershipTag,
            "Filter.2.Name": "instance-state-name",
            "Filter.2.Value.1": "pending",
            "Filter.2.Value.2": "running",
            "Filter.2.Value.3": "stopping",
            "Filter.2.Value.4": "stopped",
          },
          "list instances",
        );
      } catch {
        continue;
      }
      for (const reservation of xmlChildren(xmlChild(xml, "reservationSet"), "item")) {
        for (const item of xmlChildren(xmlChild(reservation, "instancesSet"), "item")) {
          const instanceId = xmlChild(item, "instanceId")?.text;
          if (!instanceId) continue;
          const stateName = xmlChild(xmlChild(item, "instanceState"), "name")?.text;
          const attemptTag = xmlChildren(xmlChild(item, "tagSet"), "item").find((t) => xmlChild(t, "key")?.text === "bivy-attempt");
          found.push({
            id: instanceId,
            provider: "aws",
            name: instanceId,
            region,
            status: mapAwsStatus(stateName),
            ip: xmlChild(item, "ipAddress")?.text || null,
            createdAt: xmlChild(item, "launchTime")?.text || "",
            attemptId: attemptTag ? xmlChild(attemptTag, "value")?.text : undefined,
          });
        }
      }
    }
    return found;
  },
};

// --- Fly Sprites: stateful sandboxes that suspend to ~zero when idle ---------
//
// Sprites (https://sprites.dev) are the "machines that remember" model: a
// bearer-token REST API (like Fly/Hetzner) that creates a Linux box which
// auto-SUSPENDS when idle — costing ~nothing — and RESUMES with its full
// filesystem and memory intact. That's a different lifecycle from the other
// providers: instead of destroy-when-done plus a TTL self-shutdown, a Sprite is
// KEPT and simply woken again when the user reopens its session (see `wake`
// below and the controller's resume-on-open wiring). There's no cloud-init;
// Sprites are bootstrapped by registering the daemon as a supervised *service*
// over the same REST API, which also gives a clean, single-request wake path
// (start the service) that our HTTPS exec proxy can drive with no WebSocket.
const SPRITES_HOST = "https://api.sprites.dev";
const SPRITES_SERVICE = "bivy";

const SPRITES_REGIONS = [
  { id: "iad", label: "Ashburn, VA" },
  { id: "sjc", label: "San Jose" },
  { id: "ord", label: "Chicago" },
  { id: "lhr", label: "London" },
  { id: "fra", label: "Frankfurt" },
  { id: "syd", label: "Sydney" },
  { id: "nrt", label: "Tokyo" },
];

// A Sprites size is a (cpus, ram) pair rather than a named plan. Prices are
// indicative USD/hr while ACTIVE; a suspended Sprite costs ~$0 (the UI notes
// this via `suspendsWhenIdle`).
const SPRITES_GUEST: Record<string, { cpus: number; ramMb: number }> = {
  "2x4": { cpus: 2, ramMb: 4096 },
  "4x8": { cpus: 4, ramMb: 8192 },
  "8x8": { cpus: 8, ramMb: 8192 },
  "8x16": { cpus: 8, ramMb: 16384 },
};
const SPRITES_SIZES: ProviderSize[] = [
  { id: "2x4", label: "2 vCPU · 4 GB", pricePerHour: 0.06 },
  { id: "4x8", label: "4 vCPU · 8 GB", pricePerHour: 0.115 },
  { id: "8x8", label: "8 vCPU · 8 GB", pricePerHour: 0.16 },
  { id: "8x16", label: "8 vCPU · 16 GB", pricePerHour: 0.22 },
];

function mapSpritesStatus(s: string): string {
  const v = String(s || "").toLowerCase();
  if (/(destroy|delet|gone)/.test(v)) return "gone";
  if (/(cold|susp|sleep|stop|off|hibernat)/.test(v)) return "stopped";
  if (/(run|warm|ready)/.test(v)) return "running";
  return "starting"; // creating / new / pending / starting / unknown
}

/** The boot script the `bivy` Sprites service supervises. Writes the relay
 *  enrollment from an env var (no separate file-API call), installs Bivy once
 *  (persisted across suspends by the Sprite's own storage), then runs the daemon
 *  in the foreground so the service supervisor keeps it alive and re-dials the
 *  relay after each resume. */
function bivySpritesServiceScript(installUrl: string): string {
  return [
    "set -e",
    "mkdir -p /etc/bivy",
    'printf %s "$BIVY_RELAY_JSON_B64" | base64 -d > /etc/bivy/relay.json',
    "chmod 600 /etc/bivy/relay.json",
    'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin:$PATH"',
    `command -v bivy >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq curl ca-certificates; curl -fsSL ${shq(installUrl)} | bash; }`,
    "exec bivy start",
  ].join("\n");
}

/** The env a managed-sandbox daemon runs with — relay enrollment (base64) plus
 *  the same optional BIVY_* switches the other providers export. Shared by the
 *  Fly Sprites service and the E2B template bootstrap. */
function bivyNodeEnv(opts: BootstrapOpts): Record<string, string> {
  const env: Record<string, string> = {
    BIVY_DATA_DIR: "/etc/bivy",
    BIVY_RELAY_JSON_B64: b64(utf8.encode(bivyRelayJson(opts))),
  };
  if (opts.repo) env.BIVY_REPO = opts.repo;
  if (opts.hostedTasks) env.BIVY_GITHUB_HOSTED_TASKS = "1";
  if (opts.nodeLabel) env.BIVY_NODE_LABEL = opts.nodeLabel;
  if (opts.githubToken) env.BIVY_GITHUB_TOKEN = opts.githubToken;
  if (opts.hostedMint) env.BIVY_HOSTED_MINT = "1";
  return env;
}

const sprites: ProviderAdapter = {
  id: "sprites",
  name: "Fly Sprites",
  currency: "USD",
  suspendsWhenIdle: true,
  regions: SPRITES_REGIONS,
  defaultRegion: "iad",
  sizes: SPRITES_SIZES,
  defaultSize: "4x8",
  async validateToken({ exec, token }) {
    const res = await call(exec, { method: "GET", url: `${SPRITES_HOST}/v1/sprites`, headers: bearer(token) });
    if (res.status >= 300) throw new Error(providerError(res, "validate credential"));
  },
  async provision({ exec, token, config, bootstrap }) {
    const name = `bivy-${config.slug}`;
    const guest = SPRITES_GUEST[config.size as string] || SPRITES_GUEST[sprites.defaultSize] || { cpus: 4, ramMb: 8192 };
    // 1. Create the sprite.
    const created = await call(exec, {
      method: "POST",
      url: `${SPRITES_HOST}/v1/sprites`,
      headers: { ...bearer(token), "content-type": "application/json" },
      body: {
        name,
        config: { cpus: guest.cpus, ram_mb: guest.ramMb, region: config.region || sprites.defaultRegion },
        labels: ["bivy"],
      },
    });
    if (created.status >= 300 && created.status !== 409) throw new Error(providerError(created, "create sprite"));
    if (!bootstrap) throw new Error("Sprites bootstrap missing");
    const installUrl = bootstrap.installUrl || "https://bivy.sh/install.sh";
    // 2. Register the daemon as a supervised service (PUT = create-or-replace).
    const svc = await call(exec, {
      method: "PUT",
      url: `${SPRITES_HOST}/v1/sprites/${encodeURIComponent(name)}/services/${SPRITES_SERVICE}`,
      headers: { ...bearer(token), "content-type": "application/json" },
      body: { cmd: "bash", args: ["-lc", bivySpritesServiceScript(installUrl)], env: bivyNodeEnv(bootstrap) },
    });
    if (svc.status >= 300) throw new Error(providerError(svc, "register bivy service"));
    // 3. Start the service — boots the daemon now, and is the same call `wake`
    //    uses later to resume a suspended Sprite.
    const started = await call(exec, {
      method: "POST",
      url: `${SPRITES_HOST}/v1/sprites/${encodeURIComponent(name)}/services/${SPRITES_SERVICE}/start`,
      headers: bearer(token),
    });
    if (started.status >= 300) throw new Error(providerError(started, "start bivy service"));
    return {
      id: name,
      provider: "sprites",
      app: name,
      name,
      region: config.region || sprites.defaultRegion,
      status: "starting",
      ip: null,
      createdAt: nowIso(),
    };
  },
  async status({ exec, token, machine }) {
    const res = await call(exec, {
      method: "GET",
      url: `${SPRITES_HOST}/v1/sprites/${encodeURIComponent(machine.app || machine.id)}`,
      headers: bearer(token),
    });
    if (res.status === 404) return "gone";
    if (res.status >= 300) throw new Error(providerError(res, "get sprite"));
    return mapSpritesStatus(res.body?.status);
  },
  async destroy({ exec, token, machine }) {
    const res = await call(exec, {
      method: "DELETE",
      url: `${SPRITES_HOST}/v1/sprites/${encodeURIComponent(machine.app || machine.id)}`,
      headers: bearer(token),
    });
    if (res.status >= 300 && res.status !== 404) throw new Error(providerError(res, "delete sprite"));
  },
  async wake({ exec, token, machine }) {
    // Starting the supervised service both wakes the suspended Sprite (any
    // request routed to it resumes it at the edge) and ensures the daemon is
    // running so it re-dials the relay. Idempotent on an already-running Sprite.
    const res = await call(exec, {
      method: "POST",
      url: `${SPRITES_HOST}/v1/sprites/${encodeURIComponent(machine.app || machine.id)}/services/${SPRITES_SERVICE}/start`,
      headers: bearer(token),
    });
    if (res.status >= 300 && res.status !== 404) throw new Error(providerError(res, "wake sprite"));
  },
};

// --- E2B: managed agent sandboxes with a deterministic idle timeout ----------
//
// E2B (https://e2b.dev) is the other "managed sandbox" substrate alongside Fly
// Sprites: a REST API (host api.e2b.app, `X-API-Key` auth) that creates a
// Firecracker microVM for agent workloads. Its lifecycle is enforced
// SERVER-SIDE by E2B, not by a Bivy device or node: every sandbox carries a
// `timeout`, and when it elapses E2B either KILLS the sandbox or — with
// `autoPause` — PAUSES it to ~$0 with full filesystem + memory state, resumable
// later (~1s) with everything intact.
//
// We model E2B as a suspend-when-idle provider (like Sprites): the sandbox is
// KEPT and woken via `wake` (resume) when the user reopens its session, rather
// than destroy-when-done + TTL self-shutdown. Unlike Sprites, E2B's pause is
// DETERMINISTIC — driven by the server-enforced timeout, not by an external
// idle heuristic — so it doesn't depend on the daemon's relay socket looking
// "idle" (see docs/ephemeral-sessions.md on the Sprites idle-suspend caveat).
//
// PROTOTYPE — written against E2B's documented REST shape and unit-tested with
// an injected transport, but NOT yet confirmed against a live key, and it
// depends on an external artifact. Before GA (tracked in
// docs/ephemeral-sessions.md#e2b):
//   1. Bootstrap needs published `bivy-<size>` E2B templates that install Bivy
//      and run `bivy start`, reading relay enrollment from the env vars we pass
//      at create — E2B runs a template's start command and (unlike Sprites)
//      can't take an arbitrary boot script at create time.
//   2. Endpoint paths / field names (`/v2/sandboxes`, `autoPause`, `envVars`,
//      `sandboxID`, `/resume`) need live confirmation.
//   3. The timeout is wall-clock, not activity-based: to keep a long ACTIVE
//      session warm someone must refresh it (device-online vs. a control-plane
//      keepalive) — the same lifecycle question the BYO lane tracks. For now we
//      set a generous fixed window and let autoPause preserve state if it
//      elapses mid-session.
const E2B_HOST = "https://api.e2b.app";
const E2B_TEMPLATE_PREFIX = "bivy-"; // published templates: bivy-1x2, bivy-2x4, ...
// Window (seconds) before E2B auto-pauses the sandbox to ~$0.
const E2B_TIMEOUT_S = 3600;

function e2bAuth(token: string): Record<string, string> {
  return { "X-API-Key": String(token || "").trim() };
}

// E2B sandbox resources come from the template, so each size maps to a distinct
// published template (E2B_TEMPLATE_PREFIX + size id). Prices are indicative
// USD/hr while ACTIVE, derived from E2B's per-second vCPU + RAM rates; a paused
// sandbox costs ~$0 (snapshot storage aside), surfaced via `suspendsWhenIdle`.
const E2B_SIZES: ProviderSize[] = [
  { id: "1x2", label: "1 vCPU · 2 GB", pricePerHour: 0.08 },
  { id: "2x4", label: "2 vCPU · 4 GB", pricePerHour: 0.17 },
  { id: "4x8", label: "4 vCPU · 8 GB", pricePerHour: 0.33 },
  { id: "8x16", label: "8 vCPU · 16 GB", pricePerHour: 0.66 },
];

function mapE2bStatus(s: string): string {
  const v = String(s || "").toLowerCase();
  if (/(kill|delet|destroy|gone)/.test(v)) return "gone";
  if (/(paus|susp|stop|sleep)/.test(v)) return "stopped";
  if (/(run|ready)/.test(v)) return "running";
  return "starting"; // creating / pending / resuming / unknown
}

const e2b: ProviderAdapter = {
  id: "e2b",
  name: "E2B",
  currency: "USD",
  suspendsWhenIdle: true,
  regions: [{ id: "us", label: "United States" }],
  defaultRegion: "us",
  sizes: E2B_SIZES,
  defaultSize: "2x4",
  async validateToken({ exec, token }) {
    const res = await call(exec, { method: "GET", url: `${E2B_HOST}/v2/sandboxes?limit=1`, headers: e2bAuth(token) });
    if (res.status >= 300) throw new Error(providerError(res, "validate credential"));
  },
  async provision({ exec, token, config, bootstrap }) {
    if (!bootstrap) throw new Error("E2B bootstrap missing");
    const size = (config.size as string) || e2b.defaultSize;
    // Relay enrollment + optional switches ride as env vars the published
    // `bivy-<size>` template's start command reads to run `bivy start`.
    const created = await call(exec, {
      method: "POST",
      url: `${E2B_HOST}/v2/sandboxes`,
      headers: { ...e2bAuth(token), "content-type": "application/json" },
      body: {
        templateID: `${E2B_TEMPLATE_PREFIX}${size}`,
        timeout: E2B_TIMEOUT_S,
        autoPause: true,
        metadata: { bivy: "1", slug: String(config.slug || "") },
        envVars: bivyNodeEnv(bootstrap),
      },
    });
    if (created.status >= 300 && created.status !== 409) throw new Error(providerError(created, "create sandbox"));
    const id = String(created.body?.sandboxID || created.body?.sandboxId || created.body?.id || "");
    if (!id) throw new Error("E2B create returned no sandbox id");
    return {
      id,
      provider: "e2b",
      app: id,
      name: `bivy-${config.slug}`,
      region: e2b.defaultRegion,
      status: "starting",
      ip: null,
      createdAt: nowIso(),
    };
  },
  async status({ exec, token, machine }) {
    const res = await call(exec, {
      method: "GET",
      url: `${E2B_HOST}/v2/sandboxes/${encodeURIComponent(machine.app || machine.id)}`,
      headers: e2bAuth(token),
    });
    if (res.status === 404) return "gone";
    if (res.status >= 300) throw new Error(providerError(res, "get sandbox"));
    return mapE2bStatus(res.body?.state || res.body?.status);
  },
  async destroy({ exec, token, machine }) {
    const res = await call(exec, {
      method: "DELETE",
      url: `${E2B_HOST}/v2/sandboxes/${encodeURIComponent(machine.app || machine.id)}`,
      headers: e2bAuth(token),
    });
    if (res.status >= 300 && res.status !== 404) throw new Error(providerError(res, "kill sandbox"));
  },
  async wake({ exec, token, machine }) {
    // Resume a paused sandbox so it rejoins the relay. A resume on an already
    // running sandbox may 409/400, which we treat as already-awake.
    const res = await call(exec, {
      method: "POST",
      url: `${E2B_HOST}/v2/sandboxes/${encodeURIComponent(machine.app || machine.id)}/resume`,
      headers: { ...e2bAuth(token), "content-type": "application/json" },
      body: { timeout: E2B_TIMEOUT_S, autoPause: true },
    });
    if (res.status >= 300 && res.status !== 404 && res.status !== 409) throw new Error(providerError(res, "resume sandbox"));
  },
};

const ADAPTERS: Record<string, ProviderAdapter> = { hetzner, fly, aws, sprites, e2b };
export function ephemeralAdapter(id: string): ProviderAdapter | null {
  return ADAPTERS[String(id || "").trim().toLowerCase()] || null;
}

function cpBase(store: LocalStore): string {
  return (store.cp || (typeof location !== "undefined" ? location.origin : "")).replace(/\/$/, "");
}

/** Cloud-relay transport: the control plane forwards one allowlisted request. */
export function cloudExec(store: LocalStore, fetchImpl: typeof fetch = fetch): ExecFn {
  return async (request) => {
    const res = await fetchImpl(`${cpBase(store)}/api/ephemeral/exec`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${store.s}` },
      body: JSON.stringify(request),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `exec relay failed (${res.status})`);
    return { status: data.status ?? res.status, body: data.body };
  };
}

function randHex(bytes: number): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type EphemeralLaunchPhase = "requested" | "enrolled" | "provider-accepted" | "tracked" | "failed";

export interface EphemeralLaunchEvent {
  attemptId: string;
  nodeId: string;
  phase: EphemeralLaunchPhase;
  machine?: EphemeralMachine;
  error?: string;
}

export interface LaunchOpts {
  provider: string;
  /** Stable operation identity. Hosted controllers persist this before any
   * side effect; device launches generate one locally. */
  attemptId?: string;
  /** The caller has an independent, durable controller holding deletion
   * authority. Required for providers where guest shutdown does not stop billing. */
  externalTeardownGuaranteed?: boolean;
  /** Opaque per-account tag (see `ownershipTagFor` in the control plane's
   * store) applied to the created resource alongside the attempt tag, so a
   * later orphan-discovery scan can find it even if this specific attempt's
   * record was lost. Hosted-only — device launches have no server-side
   * discovery sweep to feed, so they omit it. */
  ownershipTag?: string;
  /** Durable lifecycle sink. The initial `requested` callback is awaited before
   * enrollment, and `provider-accepted` is awaited before local machine storage. */
  onLifecycle?: (event: EphemeralLaunchEvent) => Promise<void>;
  region?: string;
  size?: string;
  /** Optional, device-local progress sink for an interactive launch. Messages
   *  describe safe lifecycle steps only — never tokens or bootstrap secrets. */
  onProgress?: (message: string) => void;
  /** Optional provider-native prebuilt runner image/snapshot. Enrollment and
   * credentials are still injected at claim time, never baked into the image. */
  image?: string;
  ttlMinutes?: number;
  repo?: string;
  name?: string;
  /** The device-local `EphemeralSetup` id this launch came from, stamped onto
   *  the resulting `EphemeralMachine` for later correlation (see
   *  `EphemeralMachine.setupId`). */
  setupId?: string;
  /** Destroy this machine when the agent emits agent_end. */
  teardownOnAgentFinish?: boolean;
  /** DEBUG: keep a boot-failed machine alive for log inspection (disables Fly
   *  `auto_destroy`). See `EPHEMERAL_KEEP_FAILED_MACHINES` in the web flags. */
  debugKeepMachine?: boolean;
  /** Opt the machine into the hosted GitHub work queue on boot (see
   *  `BootstrapOpts.hostedTasks`). Off by default so a plain "Launch machine"
   *  from the Ephemeral sheet keeps its pre-#532 behavior. */
  hostedTasks?: boolean;
  /** A GitHub token the booted node uses for repo clone/push/PR work (see
   *  `BootstrapOpts.githubToken`). Queue workers and first-run interactive
   *  machines both need it because a disposable node has no native login. */
  githubToken?: string;
  /** Have the booted machine self-mint its GitHub token from the control plane
   *  per git op (sets BIVY_HOSTED_MINT) instead of carrying a static token. */
  hostedMint?: boolean;
  /** Bookkeeping to stamp onto the resulting `EphemeralMachine` record — see
   *  `EphemeralMachine.workItemId`/`purpose`. Provisioning itself doesn't use
   *  these; callers (the queue UI) do, to track/watch what a machine is for. */
  workItemId?: string;
  purpose?: EphemeralMachine["purpose"];
  /** Rebuild-resume (Gap B): re-provision a torn-down destroy-lane session onto a
   *  new machine. Reuse the old node id + room key so the launching device still
   *  reaches it and the daemon can decrypt the session snapshot, and reuse the
   *  session id so the daemon knows which snapshot to restore on boot. */
  reuseNodeId?: string;
  reuseRoomKeyB64?: string;
  restoreSessionId?: string;
}

/** The routing-label suffix a hosted-tasks ephemeral node serves, derived from
 *  its `eph-<hex>` node id (e.g. "eph-ab12cd34" → "ab12cd34"). Deterministic
 *  and known as soon as the machine is provisioned — no need to wait for it to
 *  actually boot — so the queue "Run on ephemeral server" action can assign
 *  the item to `bivy/<label>` right after launching. */
export function ephemeralNodeLabel(nodeId: string): string {
  return nodeId.replace(/^eph-/, "");
}

/**
 * Resolve the pickable sizes for a provider. Prefers the provider's live
 * catalog (needs a saved token); falls back to the adapter's static list when
 * no adapter/token is available or the live call fails.
 */
export async function listEphemeralSizes(
  provider: string,
  deps: { exec: ExecFn; keys: EphemeralKeyStore },
  region?: string,
): Promise<ProviderSize[]> {
  const adapter = ephemeralAdapter(provider);
  if (!adapter) return [];
  if (!adapter.listSizes) return adapter.sizes;
  const token = await deps.keys.getToken(provider).catch(() => "");
  if (!token) return adapter.sizes;
  try {
    const live = await adapter.listSizes({ exec: deps.exec, token, region });
    return live.length ? live : adapter.sizes;
  } catch {
    return adapter.sizes;
  }
}

/** How long after a machine record is created we still treat its (offline) node
 *  as possibly mid-boot rather than a reapable orphan. A real ephemeral node
 *  stays *online* once connected, so an `eph-*` node still offline past this
 *  window is dead — but a machine can take a couple minutes to install Bivy and
 *  dial in, so give boots a generous margin before reaping. */
const EPHEMERAL_BOOT_GRACE_MS = 15 * 60 * 1000;

/**
 * Delete this account's orphaned ephemeral nodes so a node-limit-blocked launch
 * can proceed. An orphan is an **offline** `eph-*` node whose box self-destructed
 * or never booted and was never unenrolled. Deliberately conservative:
 *  - only `eph-*` nodes (a persistent node is never touched);
 *  - only offline ones (a live ephemeral node stays connected — this is the real
 *    safety check);
 *  - never one still inside its boot grace window (a machine we launched moments
 *    ago is offline simply because it hasn't dialed in yet).
 * When a reaped node still has a local machine record (a box that died but whose
 * "Launched machines" row lingered), that stale record is dropped too. Returns
 * how many nodes were reaped. Best-effort — a failed delete is skipped, not fatal.
 */
export async function reapOrphanEphemeralNodes(
  deps: { store: LocalStore; machines: MachineStore },
  fetchImpl: typeof fetch,
): Promise<number> {
  const auth = { authorization: `Bearer ${deps.store.s}` };
  let nodes: Array<{ id?: unknown; online?: unknown }> = [];
  try {
    const res = await fetchImpl(`${cpBase(deps.store)}/nodes`, { headers: auth });
    const data = await res.json().catch(() => []);
    if (res.ok && Array.isArray(data)) nodes = data;
  } catch {
    return 0;
  }
  const byNode = new Map<string, EphemeralMachine>();
  for (const m of await deps.machines.list().catch(() => [])) if (m.nodeId) byNode.set(m.nodeId, m);
  const now = Date.now();
  let reaped = 0;
  for (const node of nodes) {
    const id = typeof node?.id === "string" ? node.id : "";
    if (!id.startsWith("eph-") || node.online !== false) continue;
    const local = byNode.get(id);
    if (local) {
      const age = now - Date.parse(String(local.createdAt || ""));
      if (Number.isFinite(age) && age < EPHEMERAL_BOOT_GRACE_MS) continue; // likely still booting
    }
    try {
      const del = await fetchImpl(`${cpBase(deps.store)}/nodes/${encodeURIComponent(id)}`, { method: "DELETE", headers: auth });
      if (del.ok) {
        reaped++;
        if (local) await deps.machines.remove(local.id).catch(() => {});
      }
    } catch {
      /* skip; a transient delete failure just means one fewer freed slot */
    }
  }
  return reaped;
}

/**
 * Provision an ephemeral node: enroll it on the account, mint a room key, build
 * cloud-init, and ask the provider to boot a machine that self-destructs at TTL.
 */
export async function launchEphemeralMachine(
  opts: LaunchOpts,
  deps: { store: LocalStore; exec: ExecFn; keys: EphemeralKeyStore; machines: MachineStore; fetchImpl?: typeof fetch },
): Promise<EphemeralMachine> {
  const requestedAt = nowIso();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const adapter = ephemeralAdapter(opts.provider);
  if (!adapter) throw new Error(`Unknown provider: ${opts.provider}`);
  // Progress is deliberately best-effort: presentation code must never be able
  // to abort provisioning. Keep these messages free of credentials, enrollment
  // tokens, user-data, and provider response bodies.
  const progress = (message: string) => {
    try { opts.onProgress?.(message); } catch { /* UI observer only */ }
  };
  progress(`Preparing ${adapter.name} launch…`);
  const token = await deps.keys.getToken(opts.provider);
  if (!token) throw new Error(`Add a ${adapter.name} token first.`);
  if (adapter.guestCanEnsureDeletion === false && !opts.externalTeardownGuaranteed) {
    throw new Error(`${adapter.name} requires hosted provisioning: powering off its guest does not delete the billable server, so a device-only launch is unsafe.`);
  }

  // Rebuild-resume reuses the torn-down session's node id so the launching device
  // still reaches it (it holds that node's room key) and the daemon knows which
  // snapshot to restore; a normal launch mints a fresh one. Persist the stable
  // attempt before enrollment: after this callback every later side effect has a
  // durable owner even if this process crashes.
  const attemptId = opts.attemptId || randHex(16);
  const nodeId = opts.reuseNodeId || "eph-" + randHex(8);
  await opts.onLifecycle?.({ attemptId, nodeId, phase: "requested" });
  const enrollBody = JSON.stringify({ nodeId, name: opts.name || `Ephemeral ${adapter.name}` });
  progress("Enrolling a secure Bivy node…");
  const enrollOnce = async () => {
    const res = await fetchImpl(`${cpBase(deps.store)}/nodes/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deps.store.s}` },
      body: enrollBody,
    });
    return { res, data: (await res.json().catch(() => ({}))) as any };
  };
  let { res: enrollRes, data: enroll } = await enrollOnce();
  // A machine that self-destructs (or never boots) leaves its enrolled node
  // behind — the control plane isn't told the box is gone, only the device's
  // Destroy button unenrolls it. Enough of those orphaned `eph-*` nodes and the
  // account hits its plan node limit, and every new launch fails enrollment with
  // a 402 that surfaces as the generic "Could not enroll the machine". So when we
  // hit the limit, reap our own orphaned ephemeral nodes (offline `eph-*` nodes
  // this device no longer tracks a machine for — never a persistent node) and
  // retry once. Self-heals the account rather than stranding the user.
  if (!enrollRes.ok && enrollRes.status === 402 && /node limit/i.test(String(enroll?.error ?? ""))) {
    if ((await reapOrphanEphemeralNodes(deps, fetchImpl)) > 0) ({ res: enrollRes, data: enroll } = await enrollOnce());
  }
  if (!enrollRes.ok || !enroll?.enrollmentToken) {
    const error = enroll?.error || "Could not enroll the machine";
    await opts.onLifecycle?.({ attemptId, nodeId, phase: "failed", error });
    throw new Error(error);
  }
  await opts.onLifecycle?.({ attemptId, nodeId, phase: "enrolled" });
  progress("Node enrolled. Building its secure bootstrap…");

  // Reuse the old session's room key on rebuild so the device (which already
  // holds it) reaches the new machine and the daemon can decrypt the snapshot
  // that was sealed under it; otherwise mint a fresh 32-byte key.
  const roomBytes = opts.reuseRoomKeyB64 ? unb64url(opts.reuseRoomKeyB64) : crypto.getRandomValues(new Uint8Array(32));
  deps.store.addKey(nodeId, b64url(roomBytes));

  const bootstrap: BootstrapOpts = {
    relayUrl: deps.store.relay,
    controlPlaneUrl: cpBase(deps.store),
    enrollmentToken: enroll.enrollmentToken,
    e2eKeyB64: b64(roomBytes),
    ttlMinutes: opts.ttlMinutes,
    repo: opts.repo,
    hostedTasks: opts.hostedTasks,
    nodeLabel: opts.hostedTasks ? ephemeralNodeLabel(nodeId) : undefined,
    githubToken: opts.githubToken,
    hostedMint: opts.hostedMint,
    provider: opts.provider,
    teardownOnAgentFinish: opts.teardownOnAgentFinish,
    debugKeepMachine: opts.debugKeepMachine,
    restoreSessionId: opts.restoreSessionId,
  };
  // Both forms of the same boot intent: `userData` is the cloud-init payload VM
  // providers run as-is; `bootstrap` lets a provider that can't run cloud-init
  // (Fly) assemble its own boot config. Each adapter uses whichever it needs.
  const userData = buildBootstrapUserData(bootstrap);

  // The picker offers the provider's live catalog, which can be broader than
  // the static `sizes` fallback, so pass the chosen size through and only
  // substitute the default when nothing was picked. An invalid value surfaces
  // as a clear provider error rather than being silently swapped out.
  const size = opts.size || adapter.defaultSize;
  const region = opts.region || adapter.defaultRegion;
  progress(`Creating the machine in ${region} (${size})…`);
  let machine: EphemeralMachine;
  try {
    machine = await adapter.provision({
      exec: deps.exec,
      token,
      userData,
      bootstrap,
      config: { slug: ephemeralNodeLabel(nodeId), region, size, image: opts.image, ttlMinutes: opts.ttlMinutes, attemptId, ownershipTag: opts.ownershipTag },
    });
  } catch (error) {
    await opts.onLifecycle?.({
      attemptId,
      nodeId,
      phase: "failed",
      error: String((error as Error)?.message || error).slice(0, 500),
    });
    throw error;
  }
  machine.attemptId = attemptId;
  await opts.onLifecycle?.({ attemptId, nodeId, phase: "provider-accepted", machine });
  progress("Machine created. Boot setup is installing and starting Bivy…");
  machine.size = size;
  machine.milestones = { ...(machine.milestones ?? {}), requestedAt, providerAcceptedAt: nowIso() };
  machine.nodeId = nodeId;
  // Persist the user-chosen name (from a saved setup) onto the machine record.
  // Without this the record kept the provider-generated name (e.g. Fly's
  // `bivy-<slug>`), so a machine launched from a setup called "EU node" showed
  // up as `bivy-…` in every machine list — the configured name was silently
  // dropped even though the enrolled node itself carried it.
  const chosenName = String(opts.name || "").trim();
  if (chosenName) machine.name = chosenName;
  if (opts.setupId) machine.setupId = opts.setupId;
  if (opts.repo) machine.repo = opts.repo;
  if (opts.teardownOnAgentFinish) machine.teardownOnAgentFinish = true;
  if (opts.workItemId) machine.workItemId = opts.workItemId;
  if (opts.purpose) machine.purpose = opts.purpose;
  await deps.machines.add(machine);
  await opts.onLifecycle?.({ attemptId, nodeId, phase: "tracked", machine });
  return machine;
}

/** Destroy a machine at the provider, forget its record, and unenroll the node. */
export async function destroyEphemeralMachine(
  machine: EphemeralMachine,
  deps: { store: LocalStore; exec: ExecFn; keys: EphemeralKeyStore; machines: MachineStore; fetchImpl?: typeof fetch },
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const adapter = ephemeralAdapter(machine.provider);
  if (adapter) {
    const token = await deps.keys.getToken(machine.provider);
    // No token on this device: we can't authenticate the teardown. Keep the
    // record and tell the user how to fix it — dropping it here would strand a
    // machine that may still be running and billing, with no way to reach it.
    if (!token) {
      throw new Error(`Add the ${adapter.name} token on this device to destroy this machine.`);
    }
    try {
      await adapter.destroy({ exec: deps.exec, token, machine });
    } catch (e) {
      // Provider teardown failed (expired token, provider outage, rate limit).
      // Keep the local record so the machine stays listed and the user can
      // retry — silently forgetting it would leave a live, billing machine
      // orphaned. The TTL self-shutdown remains the eventual backstop.
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(`Couldn't destroy this machine at ${adapter.name}: ${detail}. It's still listed — try again in a moment.`);
    }
  }
  await deps.machines.remove(machine.id);
  if (machine.nodeId) {
    await fetchImpl(`${cpBase(deps.store)}/nodes/${encodeURIComponent(machine.nodeId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${deps.store.s}` },
    }).catch(() => {});
  }
}

/** True when a provider's machines suspend themselves to ~zero cost while idle
 *  and resume with full state (Fly Sprites). The lifecycle keeps such a machine
 *  instead of TTL-destroying it, and wakes it via `wakeEphemeralMachine` before
 *  reconnecting. */
export function ephemeralProviderSuspendsWhenIdle(provider: string): boolean {
  return ephemeralAdapter(provider)?.suspendsWhenIdle === true;
}

/** Reconstruct a minimal `EphemeralMachine` from the non-secret provider
 *  identity carried on an account node registry entry (`AccountNode.ephemeral`).
 *
 *  Cross-device resume (docs/ephemeral-sessions.md "Gap A"): the device that
 *  launched a machine holds its full record in local IndexedDB, but a *second*
 *  account device does not — so `resumeAndConnectNode` can't tell what to wake
 *  and silently hangs connecting to an off-relay node. The control-plane node
 *  registry does carry the machine's identity (provider + machine id + app +
 *  region — never a credential), so any account device can rebuild enough of the
 *  machine to call `wakeEphemeralMachine`. Waking still needs the provider token
 *  on this device; without it the wake surfaces a clear "add the token" error
 *  instead of the UI hanging.
 *
 *  Returns null when the node has no ephemeral identity (a persistent node, or an
 *  older control plane that doesn't populate the field yet) — callers fall back
 *  to the existing behaviour. Only the fields needed for wake/reconnect are set;
 *  status is "stopped" since a node we're being asked to resume is off-relay. */
/** Non-secret session↔machine correlation persisted server-side (Gap 1) so a
 *  torn-down destroy-lane session can be rebuilt after its node has been
 *  unenrolled and dropped from the node registry. Never holds a credential — the
 *  reused session's room key stays device-local (or, for hosted rebuild, escrowed
 *  server-side in node_room_keys). Mirrors the control-plane `SessionCorrelation`. */
export interface SessionCorrelation {
  sessionId: string;
  nodeId: string;
  provider: string;
  region?: string;
  ttlMinutes?: number;
  repo?: string;
  setupId?: string;
  machineId?: string;
  app?: string;
}

/** Reconstruct an `EphemeralMachine` from a durable correlation row so a rebuild
 *  can proceed after the device-local machine record and the registry node are
 *  both gone (post-teardown). Status "gone" — it no longer exists at the provider. */
export function ephemeralMachineFromCorrelation(c: SessionCorrelation): EphemeralMachine {
  return {
    id: c.machineId || c.nodeId,
    provider: c.provider,
    name: c.nodeId,
    region: c.region || "",
    status: "gone",
    ip: null,
    createdAt: "",
    ttlMinutes: c.ttlMinutes,
    app: c.app,
    nodeId: c.nodeId,
    setupId: c.setupId,
    repo: c.repo,
  };
}

/** True when a node is an ephemeral machine (Sprite/E2B/Fly) rather than a
 *  persistent one. Two independent signals, either sufficient: the `eph-*` node
 *  id every ephemeral machine is launched with (see `launchEphemeral`), or the
 *  non-secret `ephemeral` identity block the control-plane registry attaches
 *  (see `ephemeralMachineFromNode`). A persistent node has neither, and must
 *  never be swept into the ephemeral wake/rebuild path — it reconnects on its
 *  own when its daemon rejoins the relay. */
export function isEphemeralNode(node: {
  id: string;
  ephemeral?: { provider?: string; machineId?: string };
}): boolean {
  return node.id.startsWith("eph-") || !!(node.ephemeral?.provider && node.ephemeral?.machineId);
}

export function ephemeralMachineFromNode(node: {
  id: string;
  name?: string;
  ephemeral?: { provider?: string; machineId?: string; app?: string; region?: string };
}): EphemeralMachine | null {
  const e = node.ephemeral;
  if (!e || !e.provider || !e.machineId) return null;
  return {
    id: e.machineId,
    provider: e.provider,
    name: node.name || e.machineId,
    region: e.region || "",
    status: "stopped",
    ip: null,
    createdAt: "",
    app: e.app,
    nodeId: node.id,
  };
}

/** Resume a suspended machine so it rejoins the relay and becomes reachable
 *  again — the device-driven wake behind "reopen the session to resume it".
 *  No-op for providers that don't suspend (their machines are either online or
 *  destroyed). Idempotent: safe to call on a machine that's already awake. */
export async function wakeEphemeralMachine(
  machine: EphemeralMachine,
  deps: { exec: ExecFn; keys: EphemeralKeyStore },
): Promise<void> {
  const adapter = ephemeralAdapter(machine.provider);
  if (!adapter?.wake) return;
  const token = await deps.keys.getToken(machine.provider);
  if (!token) throw new Error(`Add the ${adapter.name} token on this device to resume this machine.`);
  await adapter.wake({ exec: deps.exec, token, machine });
}
