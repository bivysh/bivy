// SPDX-License-Identifier: FSL-1.1-ALv2
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

import { b64, b64url } from "./base64.js";
import type { LocalStore } from "./local-store.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface EphemeralProviderCatalog {
  id: string;
  name: string;
  tokenLabel: string;
  blurb: string;
  steps: string[];
  links: { label: string; url: string }[];
}

export const EPHEMERAL_PROVIDERS: EphemeralProviderCatalog[] = [
  {
    id: "fly",
    name: "Fly.io",
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
    tokenLabel: "Hetzner Cloud API token",
    blurb: "Bivy creates a temporary server, runs the session, then deletes it.",
    steps: [
      "Open the Hetzner Cloud Console and select or create a project for Bivy's runners.",
      "Go to Security → API Tokens and click Generate API token.",
      "Choose Read & Write, then copy the token and paste it below.",
    ],
    links: [
      { label: "Hetzner Cloud Console", url: "https://console.hetzner.cloud/projects" },
      { label: "API token docs", url: "https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/" },
    ],
  },
  {
    id: "aws",
    name: "AWS EC2",
    tokenLabel: "Access key ID and secret access key",
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
}

export interface EphemeralPrefsStore {
  get(id: string): Promise<EphemeralPrefs>;
  set(id: string, patch: Partial<EphemeralPrefs>): Promise<EphemeralPrefs>;
  remove(id: string): Promise<void>;
}

const EMPTY_PREFS: EphemeralPrefs = { region: null, size: null, ttlMinutes: null, repo: null };

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

export interface EphemeralMachine {
  id: string;
  provider: string;
  name: string;
  region: string;
  status: string; // starting | running | stopped | gone
  ip: string | null;
  createdAt: string;
  ttlMinutes?: number;
  app?: string;
  nodeId?: string;
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
  purpose?: "queue-item" | "queue-default";
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
}

export function buildBootstrapUserData(opts: BootstrapOpts): string {
  const relay = JSON.stringify({
    url: opts.relayUrl,
    enrollmentToken: opts.enrollmentToken,
    e2eKey: opts.e2eKeyB64,
    controlPlaneUrl: opts.controlPlaneUrl,
    clientBaseUrl: opts.controlPlaneUrl,
  });
  const ttl = Math.max(5, Math.min(24 * 60, Number(opts.ttlMinutes) || 60));
  const installUrl = opts.installUrl || "https://bivy.sh/install.sh";
  // Extra `export`s spliced into the same `bash -lc` invocation that runs the
  // installer, so they land in the daemon's env exactly like BIVY_REPO already
  // does. Order doesn't matter; each is independently optional.
  const exports = [
    opts.repo ? `export BIVY_REPO=${shq(opts.repo)}` : "",
    opts.hostedTasks ? `export BIVY_GITHUB_HOSTED_TASKS=1` : "",
    opts.nodeLabel ? `export BIVY_NODE_LABEL=${shq(opts.nodeLabel)}` : "",
    opts.githubToken ? `export BIVY_GITHUB_TOKEN=${shq(opts.githubToken)}` : "",
  ]
    .filter(Boolean)
    .map((line) => `${line} && `)
    .join("");
  return (
    [
      "#cloud-config",
      "write_files:",
      "  - path: /etc/bivy/relay.json",
      "    permissions: '0600'",
      "    content: |",
      indentJson(relay, "      "),
      "runcmd:",
      `  - [ bash, -lc, "mkdir -p /etc/bivy && export BIVY_DATA_DIR=/etc/bivy && ${exports}curl -fsSL ${shq(installUrl)} | bash" ]`,
      `  - [ bash, -lc, "echo 'shutdown -h now' | at now + ${ttl} minutes || (sleep ${ttl * 60} && shutdown -h now) &" ]`,
    ].join("\n") + "\n"
  );
}

/** A pickable machine size. `id` is the provider-native identifier that gets
 *  passed back as `config.size` at provision time. */
export interface ProviderSize {
  id: string;
  label: string;
}

export interface ProviderAdapter {
  id: string;
  name: string;
  regions: { id: string; label: string }[];
  defaultRegion: string;
  sizes: ProviderSize[];
  defaultSize: string;
  /** Optionally fetch the provider's live, currently-orderable sizes so the
   *  hardcoded `sizes` list can't silently go stale (e.g. a plan gets
   *  deprecated). When a region is given, results are narrowed to what that
   *  region can actually order. Falls back to `sizes` when absent or on error. */
  listSizes?(args: { exec: ExecFn; token: string; region?: string }): Promise<ProviderSize[]>;
  provision(args: { exec: ExecFn; token: string; config: any; userData: string }): Promise<EphemeralMachine>;
  status(args: { exec: ExecFn; token: string; machine: EphemeralMachine }): Promise<string>;
  destroy(args: { exec: ExecFn; token: string; machine: EphemeralMachine }): Promise<void>;
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
  sizes: [
    { id: "cpx11", label: "cpx11 · 2 vCPU · 2 GB · 40 GB (AMD x86)" },
    { id: "cpx21", label: "cpx21 · 3 vCPU · 4 GB · 80 GB (AMD x86)" },
    { id: "cpx31", label: "cpx31 · 4 vCPU · 8 GB · 160 GB (AMD x86)" },
    { id: "cpx41", label: "cpx41 · 8 vCPU · 16 GB · 240 GB (AMD x86)" },
    { id: "cpx51", label: "cpx51 · 16 vCPU · 32 GB · 360 GB (AMD x86)" },
    { id: "cax11", label: "cax11 · 2 vCPU · 4 GB · 40 GB (Arm64)" },
    { id: "cax21", label: "cax21 · 4 vCPU · 8 GB · 80 GB (Arm64)" },
    { id: "cax31", label: "cax31 · 8 vCPU · 16 GB · 160 GB (Arm64)" },
    { id: "cax41", label: "cax41 · 16 vCPU · 32 GB · 320 GB (Arm64)" },
  ],
  // x86, 4 GB — closest drop-in for the retired cx22, and x86 avoids the
  // Arm-compat pitfalls of the cax line for Docker images and binaries.
  defaultSize: "cpx21",
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
      .map(({ id, label }) => ({ id, label }));
  },
  async provision({ exec, token, config, userData }) {
    const name = `bivy-${config.slug}`;
    const res = await call(exec, {
      method: "POST",
      url: "https://api.hetzner.cloud/v1/servers",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: {
        name,
        server_type: config.size || hetzner.defaultSize,
        image: "ubuntu-24.04",
        location: config.region || "nbg1",
        user_data: userData,
        start_after_create: true,
        labels: { bivy: "ephemeral" },
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
};

// Maps a Fly size id to the guest spec sent in the machine config.
const FLY_GUEST: Record<string, { cpus: number; memoryMb: number }> = {
  "shared-1x-1gb": { cpus: 1, memoryMb: 1024 },
  "shared-1x-2gb": { cpus: 1, memoryMb: 2048 },
  "shared-2x-4gb": { cpus: 2, memoryMb: 4096 },
  "shared-4x-8gb": { cpus: 4, memoryMb: 8192 },
};

const fly: ProviderAdapter = {
  id: "fly",
  name: "Fly.io",
  regions: [
    { id: "iad", label: "Ashburn, VA" },
    { id: "sjc", label: "San Jose" },
    { id: "lhr", label: "London" },
    { id: "fra", label: "Frankfurt" },
    { id: "syd", label: "Sydney" },
    { id: "nrt", label: "Tokyo" },
  ],
  defaultRegion: "iad",
  sizes: [
    { id: "shared-1x-1gb", label: "shared · 1 vCPU · 1 GB" },
    { id: "shared-1x-2gb", label: "shared · 1 vCPU · 2 GB" },
    { id: "shared-2x-4gb", label: "shared · 2 vCPU · 4 GB" },
    { id: "shared-4x-8gb", label: "shared · 4 vCPU · 8 GB" },
  ],
  defaultSize: "shared-1x-2gb",
  async provision({ exec, token, config, userData }) {
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
    const machine = await call(exec, {
      method: "POST",
      url: `https://api.machines.dev/v1/apps/${encodeURIComponent(app)}/machines`,
      headers: { ...bearer(token), "content-type": "application/json" },
      body: {
        region: config.region || "iad",
        config: {
          image: config.image || "ubuntu:24.04",
          auto_destroy: true,
          restart: { policy: "no" },
          guest: { cpu_kind: "shared", cpus: Number(config.cpus) || guest.cpus, memory_mb: Number(config.memoryMb) || guest.memoryMb },
          metadata: { bivy: "ephemeral" },
          init: { user_data: userData },
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
const AWS_SIZES: ProviderSize[] = [
  { id: "t3.micro", label: "t3.micro · 2 vCPU · 1 GB" },
  { id: "t3.small", label: "t3.small · 2 vCPU · 2 GB" },
  { id: "t3.medium", label: "t3.medium · 2 vCPU · 4 GB" },
  { id: "t3.large", label: "t3.large · 2 vCPU · 8 GB" },
  { id: "t3.xlarge", label: "t3.xlarge · 4 vCPU · 16 GB" },
  { id: "t3.2xlarge", label: "t3.2xlarge · 8 vCPU · 32 GB" },
];

const aws: ProviderAdapter = {
  id: "aws",
  name: "AWS EC2",
  regions: AWS_REGIONS,
  defaultRegion: "us-east-1",
  sizes: AWS_SIZES,
  defaultSize: "t3.medium",
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
      .map((item) => {
        const id = xmlChild(item, "instanceType")?.text || "";
        const vcpus = xmlChild(xmlChild(item, "vCpuInfo"), "defaultVCpus")?.text;
        const memMib = xmlChild(xmlChild(item, "memoryInfo"), "sizeInMiB")?.text;
        const gb = memMib ? Math.round(Number(memMib) / 1024) : undefined;
        return id ? { id, label: `${id} · ${vcpus ?? "?"} vCPU · ${gb ?? "?"} GB` } : null;
      })
      .filter((r): r is ProviderSize => Boolean(r));
    return rows.length ? rows : AWS_SIZES;
  },
  async provision({ exec, token, config, userData }) {
    const creds = parseAwsToken(token);
    const region = config.region || aws.defaultRegion;
    const name = `bivy-${config.slug}`;
    const amiId = await resolveUbuntuAmi(exec, creds, region);
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
        // Require IMDSv2 (session-token) and pin the hop limit to 1. The bootstrap
        // user-data carries the relay enrollment token + room key, so this closes
        // the classic SSRF path to the instance metadata endpoint (an agent coaxed
        // into fetching http://169.254.169.254/… can't read it without a PUT-minted
        // token, and hop-limit 1 keeps any container/proxied request from reaching
        // IMDS at all). Cloud-init on the host itself still reads user-data over
        // IMDSv2 at boot, so provisioning is unaffected.
        "MetadataOptions.HttpTokens": "required",
        "MetadataOptions.HttpEndpoint": "enabled",
        "MetadataOptions.HttpPutResponseHopLimit": "1",
        "TagSpecification.1.ResourceType": "instance",
        "TagSpecification.1.Tag.1.Key": "Name",
        "TagSpecification.1.Tag.1.Value": name,
        "TagSpecification.1.Tag.2.Key": "bivy",
        "TagSpecification.1.Tag.2.Value": "ephemeral",
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
};

const ADAPTERS: Record<string, ProviderAdapter> = { hetzner, fly, aws };
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

export interface LaunchOpts {
  provider: string;
  region?: string;
  size?: string;
  ttlMinutes?: number;
  repo?: string;
  name?: string;
  /** Opt the machine into the hosted GitHub work queue on boot (see
   *  `BootstrapOpts.hostedTasks`). Off by default so a plain "Launch machine"
   *  from the Ephemeral sheet keeps its pre-#532 behavior. */
  hostedTasks?: boolean;
  /** A GitHub token the booted node uses for queue work (see
   *  `BootstrapOpts.githubToken`). Only meaningful with `hostedTasks`. */
  githubToken?: string;
  /** Bookkeeping to stamp onto the resulting `EphemeralMachine` record — see
   *  `EphemeralMachine.workItemId`/`purpose`. Provisioning itself doesn't use
   *  these; callers (the queue UI) do, to track/watch what a machine is for. */
  workItemId?: string;
  purpose?: EphemeralMachine["purpose"];
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

/**
 * Provision an ephemeral node: enroll it on the account, mint a room key, build
 * cloud-init, and ask the provider to boot a machine that self-destructs at TTL.
 */
export async function launchEphemeralMachine(
  opts: LaunchOpts,
  deps: { store: LocalStore; exec: ExecFn; keys: EphemeralKeyStore; machines: MachineStore; fetchImpl?: typeof fetch },
): Promise<EphemeralMachine> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const adapter = ephemeralAdapter(opts.provider);
  if (!adapter) throw new Error(`Unknown provider: ${opts.provider}`);
  const token = await deps.keys.getToken(opts.provider);
  if (!token) throw new Error(`Add a ${adapter.name} token first.`);

  const nodeId = "eph-" + randHex(8);
  const enrollRes = await fetchImpl(`${cpBase(deps.store)}/nodes/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deps.store.s}` },
    body: JSON.stringify({ nodeId, name: opts.name || `Ephemeral ${adapter.name}` }),
  });
  const enroll: any = await enrollRes.json().catch(() => ({}));
  if (!enrollRes.ok || !enroll?.enrollmentToken) throw new Error(enroll?.error || "Could not enroll the machine");

  const roomBytes = crypto.getRandomValues(new Uint8Array(32));
  deps.store.addKey(nodeId, b64url(roomBytes));

  const userData = buildBootstrapUserData({
    relayUrl: deps.store.relay,
    controlPlaneUrl: cpBase(deps.store),
    enrollmentToken: enroll.enrollmentToken,
    e2eKeyB64: b64(roomBytes),
    ttlMinutes: opts.ttlMinutes,
    repo: opts.repo,
    hostedTasks: opts.hostedTasks,
    nodeLabel: opts.hostedTasks ? ephemeralNodeLabel(nodeId) : undefined,
    githubToken: opts.githubToken,
  });

  // The picker offers the provider's live catalog, which can be broader than
  // the static `sizes` fallback, so pass the chosen size through and only
  // substitute the default when nothing was picked. An invalid value surfaces
  // as a clear provider error rather than being silently swapped out.
  const size = opts.size || adapter.defaultSize;
  const machine = await adapter.provision({
    exec: deps.exec,
    token,
    userData,
    config: { slug: ephemeralNodeLabel(nodeId), region: opts.region || adapter.defaultRegion, size, ttlMinutes: opts.ttlMinutes },
  });
  machine.nodeId = nodeId;
  if (opts.repo) machine.repo = opts.repo;
  if (opts.workItemId) machine.workItemId = opts.workItemId;
  if (opts.purpose) machine.purpose = opts.purpose;
  await deps.machines.add(machine);
  return machine;
}

/** Destroy a machine at the provider, forget its record, and unenroll the node. */
export async function destroyEphemeralMachine(
  machine: EphemeralMachine,
  deps: { store: LocalStore; exec: ExecFn; keys: EphemeralKeyStore; machines: MachineStore; fetchImpl?: typeof fetch },
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const adapter = ephemeralAdapter(machine.provider);
  const token = adapter ? await deps.keys.getToken(machine.provider) : "";
  if (adapter && token) {
    try {
      await adapter.destroy({ exec: deps.exec, token, machine });
    } catch {
      /* still forget it locally + unenroll below */
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
