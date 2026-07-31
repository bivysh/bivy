// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Server-side (control-plane-orchestrated) ephemeral provisioning. When a work
// item is enqueued and the account's routing points at an ephemeral config —
// either as the primary runner, or as a persistent node's fallback while that
// node is offline — the CONTROL PLANE launches the machine itself, with no
// device online. This is the "truly unattended, device-offline provisioning"
// path: it reuses core's `launchEphemeralMachine` but supplies server-side
// implementations of its device-shaped deps (provider token from the account's
// hosted credentials, a direct provider-call exec, a store-backed machine
// tracker, and a minimal LocalStore shim carrying the enroll bearer + bootstrap
// URLs).
//
// SECURITY: this path depends on credentials held on the control plane (see
// HostedProvisioning in store.ts). It is gated per account and off by default.
import {
  launchEphemeralMachine,
  type ExecFn,
  type ExecRequest,
  type LocalStore,
  type EphemeralMachine,
  type EphemeralKeyStore,
  type MachineStore,
} from "@bivy/core";
import type { MeshStore, EphemeralNodeConfig, QueueRouting, HostedAuditEvent } from "./store.js";
import { mintInstallationToken } from "./hosted-github-auth.js";

export interface ProvisionEnv {
  /** Public control-plane base URL the booted machine enrolls/reports to. */
  cpBaseUrl: string;
  /** Relay URL baked into the machine's cloud-init bootstrap. */
  relayUrl: string;
}

export interface ProvisionPlan {
  willProvision: boolean;
  targetConfigId: string | null;
  reason: string;
}

const DEDUPE_WINDOW_MS = 60 * 60 * 1000; // don't stack hosted machines within an hour
const MAX_PROVISIONS_PER_HOUR = Math.max(1, Number(process.env.HOSTED_PROVISION_MAX_PER_HOUR ?? 5));

function withinMs(iso: unknown, ms: number, nowMs: number): boolean {
  if (typeof iso !== "string") return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && nowMs - t < ms;
}

// Best-effort append to the account's hosted-credential audit trail. `at` is
// stamped here; failures never block provisioning.
async function audit(store: MeshStore, accountId: string, event: Omit<HostedAuditEvent, "at">): Promise<void> {
  try {
    await store.appendHostedAudit(accountId, { at: new Date().toISOString(), ...event });
  } catch {
    /* audit is best-effort */
  }
}

/**
 * Which ephemeral config (if any) the account's routing wants auto-provisioned.
 * A config primary is the designated runner; a node primary provisions its
 * fallback config (the caller checks node liveness before using this).
 */
export function resolveAutoProvisionTarget(
  routing: QueueRouting,
  configs: EphemeralNodeConfig[],
): EphemeralNodeConfig | undefined {
  const byId = new Map(configs.map((c) => [c.id, c]));
  if (routing.primary.kind === "config") return byId.get(routing.primary.configId);
  if (routing.primary.kind === "node" && routing.fallback) return byId.get(routing.fallback.configId);
  return undefined;
}

/** Decide whether to provision, without launching. Safe to expose for dry-runs. */
export async function planAutoProvision(store: MeshStore, accountId: string, nowMs = Date.now()): Promise<ProvisionPlan> {
  const hosted = await store.getHostedProvisioning(accountId);
  if (!hosted.enabled) return { willProvision: false, targetConfigId: null, reason: "hosted provisioning disabled" };
  const routing = await store.getQueueRouting(accountId);
  const configs = await store.getEphemeralConfigs(accountId);
  const target = resolveAutoProvisionTarget(routing, configs);
  if (!target) return { willProvision: false, targetConfigId: null, reason: "routing does not point at an ephemeral config" };
  if (!hosted.providerTokens?.[target.provider]) {
    return { willProvision: false, targetConfigId: target.id, reason: `no hosted token for provider ${target.provider}` };
  }
  // A config primary is the designated runner (provision regardless of node
  // liveness). A node primary only falls back to its config when nothing online.
  if (routing.primary.kind === "node") {
    const nodes = await store.listNodes(accountId);
    if (nodes.some((n) => n.online)) return { willProvision: false, targetConfigId: target.id, reason: "primary node is online" };
  }
  const active = (await store.getHostedMachines(accountId)).filter((m) => withinMs(m.createdAt, DEDUPE_WINDOW_MS, nowMs));
  if (active.length > 0) return { willProvision: false, targetConfigId: target.id, reason: "a hosted machine is already active" };
  // Rate cap: bound provisions per account per hour (cost + runaway guard).
  const recentLaunches = (await store.listHostedAudit(accountId, 100)).filter(
    (e) => e.action === "provision_launched" && withinMs(e.at, DEDUPE_WINDOW_MS, nowMs),
  );
  if (recentLaunches.length >= MAX_PROVISIONS_PER_HOUR) {
    return { willProvision: false, targetConfigId: target.id, reason: `rate limit: ${MAX_PROVISIONS_PER_HOUR} provisions/hour reached` };
  }
  return { willProvision: true, targetConfigId: target.id, reason: "ready to provision" };
}

// Direct server-side provider-call exec (mirrors the /api/ephemeral/exec relay
// handler). Core applies its host allowlist (assertAllowedUrl) before calling.
function directExec(): ExecFn {
  return async ({ method, url, headers, body }: ExecRequest) => {
    const res = await fetch(url, {
      method,
      headers: headers as Record<string, string> | undefined,
      body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      redirect: "manual",
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep raw text */
    }
    return { status: res.status, body: parsed };
  };
}

function serverKeyStore(providerToken: string): EphemeralKeyStore {
  return {
    list: async () => [],
    getToken: async () => providerToken,
    setToken: async () => {},
    remove: async () => {},
  };
}

// Machine records persisted to the account's hosted_machines JSONB. On add we
// prune to a recent window so the list can't grow unbounded (TTL destroys the
// real VMs; this is only bookkeeping for dedupe/teardown).
function serverMachineStore(store: MeshStore, accountId: string, nowMs: number): MachineStore {
  return {
    list: async () => (await store.getHostedMachines(accountId)) as unknown as EphemeralMachine[],
    add: async (m) => {
      const cur = await store.getHostedMachines(accountId);
      const recent = cur.filter((x) => withinMs(x.createdAt, 6 * 60 * 60 * 1000, nowMs));
      await store.setHostedMachines(accountId, [...recent, m as unknown as Record<string, unknown>]);
      return m;
    },
    update: async (id, patch) => {
      const cur = await store.getHostedMachines(accountId);
      const next = cur.map((x) => (x.id === id ? { ...x, ...patch } : x));
      await store.setHostedMachines(accountId, next);
      return (next.find((x) => x.id === id) as unknown as EphemeralMachine) ?? null;
    },
    remove: async (id) => {
      const cur = await store.getHostedMachines(accountId);
      await store.setHostedMachines(accountId, cur.filter((x) => x.id !== id));
    },
  };
}

// Minimal LocalStore satisfying launchEphemeralMachine + cpBase/authHeaders. Only
// s/cp/relay/addKey are meaningful server-side; the rest are unused by the launch
// path and stubbed. The room key from addKey is retained on the machine record
// so a device could later attach E2E (unattended queue work doesn't need it).
function serverLocalStore(opts: { sessionToken: string; env: ProvisionEnv; onAddKey: (nodeId: string, key: string) => void }): LocalStore {
  const empty = () => ({}) as Record<string, string>;
  return {
    s: opts.sessionToken,
    cp: opts.env.cpBaseUrl,
    relay: opts.env.relayUrl,
    cur: "",
    keys: empty,
    addKey: (id: string, key: string) => opts.onAddKey(id, key),
    nodePubs: empty,
    addNodePub: () => {},
    pairSecrets: empty,
    setPairSecret: () => {},
    clearPairSecret: () => {},
    device: () => null,
    setDevice: () => {},
    clearDevice: () => {},
    sessions: () => ({}),
    setSessions: () => {},
    lastChoice: () => ({}) as LocalStore extends { lastChoice: () => infer T } ? T : never,
    setLastChoice: () => {},
    clear: () => {},
  } as unknown as LocalStore;
}

/** Launch an ephemeral machine for `config` on behalf of the account. */
export async function provisionEphemeralForAccount(
  store: MeshStore,
  accountId: string,
  config: EphemeralNodeConfig,
  env: ProvisionEnv,
  launcher = launchEphemeralMachine,
  nowMs = Date.now(),
): Promise<EphemeralMachine> {
  const hosted = await store.getHostedProvisioning(accountId);
  const providerToken = hosted.providerTokens?.[config.provider];
  if (!providerToken) throw new Error(`No hosted provider token for ${config.provider}`);
  await audit(store, accountId, { action: "provision_attempt", provider: config.provider, configId: config.id });

  // Prefer a freshly-minted, short-lived GitHub App installation token over a
  // stored PAT (see docs/hosted-provisioning-trust-model.md). Falls back to the
  // PAT only when no app is configured.
  let githubToken = hosted.githubToken;
  if (hosted.githubApp) {
    const minted = await mintInstallationToken(hosted.githubApp);
    githubToken = minted.token;
    await audit(store, accountId, { action: "token_minted", detail: `installation token, expires ${minted.expiresAt}` });
  }

  // Enroll runs over HTTP against our own /nodes/enroll with this bearer.
  const sessionToken = await store.createSession(accountId);
  let roomKeyB64 = "";
  const localStore = serverLocalStore({ sessionToken, env, onAddKey: (_id, key) => { roomKeyB64 = key; } });
  try {
    const machine = await launcher(
      {
        provider: config.provider,
        region: config.region,
        size: config.size,
        ttlMinutes: config.ttlMinutes,
        hostedTasks: true,
        githubToken,
        setupId: config.id,
        purpose: "queue-default",
        name: `Hosted ${config.name}`,
      },
      { store: localStore, exec: directExec(), keys: serverKeyStore(providerToken), machines: serverMachineStore(store, accountId, nowMs) },
    );
    void roomKeyB64; // persisted on the machine record via the machine store
    await audit(store, accountId, { action: "provision_launched", provider: config.provider, configId: config.id, nodeId: machine.nodeId });
    return machine;
  } catch (e) {
    await audit(store, accountId, { action: "provision_failed", provider: config.provider, configId: config.id, detail: String((e as Error)?.message || e).slice(0, 200) });
    throw e;
  }
}

/**
 * Mint a fresh installation token for the account's hosted GitHub App. Used by
 * the mint-on-demand endpoint so a long-running machine can re-fetch a token per
 * git op instead of holding a long-lived one. Returns null if hosted
 * provisioning is off or no app is configured.
 */
export async function mintHostedInstallationToken(store: MeshStore, accountId: string): Promise<{ token: string; expiresAt: string } | null> {
  const hosted = await store.getHostedProvisioning(accountId);
  if (!hosted.enabled || !hosted.githubApp) return null;
  const minted = await mintInstallationToken(hosted.githubApp);
  await audit(store, accountId, { action: "token_minted", detail: "mint-on-demand" });
  return minted;
}

/**
 * Server-side lifecycle reconciliation: drop tracking records for hosted
 * machines past their TTL (the VM self-destructs at TTL; this frees the node
 * slot and keeps the dedupe/rate-cap views accurate) and unenroll their nodes.
 * Returns the number reaped. Safe to run on a timer.
 */
export async function reconcileHostedMachines(store: MeshStore, accountId: string, nowMs = Date.now()): Promise<number> {
  const machines = await store.getHostedMachines(accountId);
  if (!machines.length) return 0;
  const kept: Array<Record<string, unknown>> = [];
  let reaped = 0;
  for (const m of machines) {
    const createdAt = typeof m.createdAt === "string" ? Date.parse(m.createdAt) : NaN;
    const ttlMin = typeof m.ttlMinutes === "number" ? m.ttlMinutes : 60;
    const graceMs = (ttlMin + 15) * 60 * 1000; // TTL + boot/teardown grace
    if (Number.isFinite(createdAt) && nowMs - createdAt <= graceMs) {
      kept.push(m);
      continue;
    }
    reaped++;
    const nodeId = typeof m.nodeId === "string" ? m.nodeId : "";
    if (nodeId) {
      try {
        await store.removeNode(accountId, nodeId);
      } catch {
        /* best effort — the VM self-destructs regardless */
      }
    }
    await audit(store, accountId, { action: "machine_reaped", nodeId: nodeId || undefined, detail: `ttl ${ttlMin}m elapsed` });
  }
  if (reaped) await store.setHostedMachines(accountId, kept);
  return reaped;
}

/**
 * Fire-and-forget entry point, called after a work item is enqueued. Gated by
 * planAutoProvision (enabled + routing target + creds + liveness + dedupe), then
 * launches. Never throws to its caller — provisioning failures are logged.
 */
export async function maybeAutoProvision(
  store: MeshStore,
  accountId: string,
  env: ProvisionEnv,
  launcher = launchEphemeralMachine,
): Promise<EphemeralMachine | null> {
  try {
    // Lazy lifecycle reconciliation: prune machines past TTL before deciding, so
    // dedupe/rate-cap see fresh state and node slots are freed.
    await reconcileHostedMachines(store, accountId).catch(() => {});
    const plan = await planAutoProvision(store, accountId);
    if (!plan.willProvision || !plan.targetConfigId) return null;
    const configs = await store.getEphemeralConfigs(accountId);
    const target = configs.find((c) => c.id === plan.targetConfigId);
    if (!target) return null;
    return await provisionEphemeralForAccount(store, accountId, target, env, launcher);
  } catch (e) {
    console.error(`[hosted-provision] account ${accountId}:`, (e as Error)?.message || e);
    return null;
  }
}
