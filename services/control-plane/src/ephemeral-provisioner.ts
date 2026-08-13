// SPDX-License-Identifier: AGPL-3.0-only
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
import { randomUUID } from "node:crypto";
import {
  launchEphemeralMachine,
  destroyEphemeralMachine,
  ephemeralNodeLabel,
  ephemeralCatalogEntry,
  validateEphemeralProviderToken,
  ephemeralAdapter,
  type ExecFn,
  type ExecRequest,
  type LocalStore,
  type EphemeralMachine,
  type EphemeralKeyStore,
  type MachineStore,
  type EphemeralLaunchEvent,
} from "@bivy/core";
import { providerCredentialFingerprint, type MeshStore, type EphemeralNodeConfig, type QueueRouting, type HostedAuditEvent, type HostedMachineAttempt, type HostedMachineAttemptState } from "./store.js";
import { mintInstallationToken } from "./hosted-github-auth.js";
import { encryptSecret, decryptSecret } from "./hosted-crypto.js";

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

export interface HostedExecutionReadiness { ready: boolean; reason: string; configId?: string }

/** Static account capability for automation UI. Unlike planAutoProvision this
 * does not inspect pending work, active machines, rate limits, or node liveness. */
export async function hostedExecutionReadiness(store: MeshStore, accountId: string): Promise<HostedExecutionReadiness> {
  if (!ephemeralMachinesEnabled()) return { ready: false, reason: "deployment emergency switch is off" };
  const hosted = await store.getHostedProvisioning(accountId);
  if (!hosted.enabled) return { ready: false, reason: "unattended provisioning is disabled" };
  const routing = await store.getQueueRouting(accountId);
  const config = resolveAutoProvisionTarget(routing, await store.getEphemeralConfigs(accountId));
  if (!config) return { ready: false, reason: "automation routing has no ephemeral config" };
  const token = hosted.providerTokens?.[config.provider];
  if (!token) return { ready: false, reason: `no hosted ${config.provider} credential` };
  if (hosted.validatedProviders?.[config.provider] !== providerCredentialFingerprint(token)) {
    return { ready: false, reason: `${config.provider} credential is not validated` };
  }
  return { ready: true, reason: "hosted ephemeral execution is ready", configId: config.id };
}

export const EPHEMERAL_MILESTONES = ["nodeReadyAt", "credentialsReadyAt", "snapshotReadyAt", "firstAgentEventAt"] as const;
export type EphemeralMilestone = (typeof EPHEMERAL_MILESTONES)[number];

/** Server-stamp a hosted runner milestone. First write wins so reconnects and
 * repeated agent events cannot move the SLO boundary later. */
export async function markHostedMachineMilestone(
  store: MeshStore,
  accountId: string,
  nodeId: string,
  milestone: EphemeralMilestone,
  at = new Date().toISOString(),
): Promise<boolean> {
  const machines = await store.getHostedMachines(accountId);
  let found = false;
  let recorded = false;
  let requestedAt: string | undefined;
  const next = machines.map((machine) => {
    if (machine.nodeId !== nodeId) return machine;
    found = true;
    const milestones = machine.milestones && typeof machine.milestones === "object"
      ? machine.milestones as Record<string, unknown>
      : {};
    if (typeof milestones[milestone] === "string") return machine;
    recorded = true;
    requestedAt = typeof milestones.requestedAt === "string" ? milestones.requestedAt : undefined;
    return { ...machine, milestones: { ...milestones, [milestone]: at } };
  });
  if (found) await store.setHostedMachines(accountId, next);
  if (recorded) {
    const machine = next.find((m) => m.nodeId === nodeId);
    const attemptId = typeof machine?.attemptId === "string" ? machine.attemptId : "";
    if (attemptId) {
      const attempt = await store.getHostedMachineAttempt(accountId, attemptId).catch(() => undefined);
      if (attempt) {
        const state: HostedMachineAttemptState = milestone === "firstAgentEventAt" ? "working"
          : milestone === "credentialsReadyAt" ? "ready"
          : attempt.state;
        await store.putHostedMachineAttempt({ ...attempt, state, machine, updatedAt: at }).catch(() => {});
      }
    }

    const startMs = Date.parse(String(requestedAt || ""));
    const atMs = Date.parse(at);
    const elapsed = Number.isFinite(startMs) && Number.isFinite(atMs) && atMs >= startMs ? ` elapsedMs=${atMs - startMs}` : "";
    await audit(store, accountId, { action: "machine_milestone", nodeId, detail: `${milestone}${elapsed}` });
  }
  return found;
}

const DEDUPE_WINDOW_MS = 60 * 60 * 1000; // don't stack hosted machines within an hour
const MAX_PROVISIONS_PER_HOUR = Math.max(1, Number(process.env.HOSTED_PROVISION_MAX_PER_HOUR ?? 5));
const READY_MIN_REMAINING_MS = 5 * 60 * 1000;
const PROVISION_LEASE_SECONDS = 5 * 60;

/** Keep a cross-replica provision lease alive while a slow provider call is in
 * flight. Without renewal, expiry permits a second replica to launch another
 * paid machine while the first request is merely slow. */
function startLeaseHeartbeat(store: MeshStore, accountId: string, holder: string): () => void {
  const timer = setInterval(() => {
    void store.renewHostedProvisionLease(accountId, holder, PROVISION_LEASE_SECONDS).then((owned) => {
      if (!owned) console.error(`[hosted-provision] lost lease account=${accountId} holder=${holder}`);
    }).catch((error) => console.error(`[hosted-provision] lease renewal failed account=${accountId}:`, error));
  }, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

function readyMachineUsable(machine: Record<string, unknown>, nowMs = Date.now()): boolean {
  const createdAt = Date.parse(String(machine.createdAt || ""));
  const ttlMs = (typeof machine.ttlMinutes === "number" ? machine.ttlMinutes : 60) * 60 * 1000;
  return Number.isFinite(createdAt) && createdAt + ttlMs - nowMs > READY_MIN_REMAINING_MS;
}

/**
 * Deployment-level emergency kill switch. Product access is gated per account
 * by hosted.enabled + a provider credential; the deploy flag exists only to stop
 * all NEW launches during an incident. Cleanup ignores this switch.
 */
export function ephemeralMachinesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EPHEMERAL_MACHINES_ENABLED !== "0";
}

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
  // Deployment emergency gate: exact `0` disables new launches; otherwise the
  // per-account hosted opt-in is authoritative. This is the single choke point
  // for ALL server-initiated auto-launches — both maybeAutoProvision
  // call sites route through here. Mirrors the /api/ephemeral/exec relay guard
  // (device-initiated launches) and the web VITE_EPHEMERAL_MACHINES_ENABLED flag.
  if (!ephemeralMachinesEnabled()) {
    return { willProvision: false, targetConfigId: null, reason: "ephemeral machines disabled (EPHEMERAL_MACHINES_ENABLED)" };
  }
  const hosted = await store.getHostedProvisioning(accountId);
  if (!hosted.enabled) return { willProvision: false, targetConfigId: null, reason: "hosted provisioning disabled" };
  const routing = await store.getQueueRouting(accountId);
  const configs = await store.getEphemeralConfigs(accountId);
  const target = resolveAutoProvisionTarget(routing, configs);
  if (!target) return { willProvision: false, targetConfigId: null, reason: "routing does not point at an ephemeral config" };
  if (!hosted.providerTokens?.[target.provider]) {
    return { willProvision: false, targetConfigId: target.id, reason: `no hosted token for provider ${target.provider}` };
  }
  if (hosted.validatedProviders?.[target.provider] !== providerCredentialFingerprint(hosted.providerTokens[target.provider])) {
    return { willProvision: false, targetConfigId: target.id, reason: `provider credential for ${target.provider} has not been validated` };
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

/** Read-only hosted onboarding check. The credential is used transiently for a
 * provider-authenticated list/describe call and is not persisted by this helper. */
export function validateHostedProviderToken(provider: string, token: string, region?: string): Promise<void> {
  return validateEphemeralProviderToken(provider, token, directExec(), region);
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

/**
 * Select a torn-down session to rebuild server-side: a pending work item that
 * targets an existing session whose durable correlation names a node with an
 * escrowed room key (Gap 3). Returns the reuse args, or null when no restorable
 * candidate exists (→ normal fresh provision). Requires a correlation for the
 * target session — written by the device when it launches an ephemeral, and
 * (for purely hosted-origin sessions with no device) by the CP on session advert
 * via `correlateHostedSessions` (hosted-correlation.ts).
 */
async function planRestoreProvision(
  store: MeshStore,
  accountId: string,
): Promise<{ reuseNodeId: string; restoreSessionId: string } | null> {
  const items = await store.listWorkItems(accountId, 50).catch(() => []);
  for (const it of items) {
    if (it.status !== "pending" || it.targetKind !== "existing_session" || !it.targetSessionId) continue;
    const corr = await store.getSessionCorrelation(accountId, it.targetSessionId).catch(() => undefined);
    if (!corr) continue;
    const enc = await store.getNodeRoomKeyEnc(accountId, corr.nodeId).catch(() => undefined);
    if (!enc) continue;
    return { reuseNodeId: corr.nodeId, restoreSessionId: it.targetSessionId };
  }
  return null;
}

/** Launch an ephemeral machine for `config` on behalf of the account. */
export async function provisionEphemeralForAccount(
  store: MeshStore,
  accountId: string,
  config: EphemeralNodeConfig,
  env: ProvisionEnv,
  launcher = launchEphemeralMachine,
  nowMs = Date.now(),
  purpose: EphemeralMachine["purpose"] = "queue-default",
  retry?: { attemptId: string; nodeId: string; retryCount: number },
): Promise<EphemeralMachine> {
  const hosted = await store.getHostedProvisioning(accountId);
  const providerToken = hosted.providerTokens?.[config.provider];
  if (!providerToken) throw new Error(`No hosted provider token for ${config.provider}`);
  await audit(store, accountId, { action: "provision_attempt", provider: config.provider, configId: config.id });

  // With a GitHub App, the machine self-mints a fresh, short-lived installation
  // token from the control plane per git op (BIVY_HOSTED_MINT) — no static
  // credential is ever baked into the machine, and long sessions keep working.
  // With only a stored PAT, inject it statically (the legacy fallback).
  const useHostedMint = Boolean(hosted.githubApp);
  const githubToken = useHostedMint ? undefined : hosted.githubToken;

  // Enroll runs over HTTP against our own /nodes/enroll with this bearer.
  const sessionToken = await store.createSession(accountId);
  let roomKeyB64 = "";
  const localStore = serverLocalStore({ sessionToken, env, onAddKey: (_id, key) => { roomKeyB64 = key; } });
  const attemptId = retry?.attemptId ?? randomUUID();
  const createdAt = new Date(nowMs).toISOString();
  let attempt: HostedMachineAttempt | undefined;
  const onLifecycle = async (event: EphemeralLaunchEvent): Promise<void> => {
    attempt = await store.putHostedMachineAttempt({
      accountId, attemptId: event.attemptId, provider: config.provider, configId: config.id,
      nodeId: event.nodeId, state: event.phase as HostedMachineAttemptState,
      desired: { region: config.region, size: config.size, image: config.image, ttlMinutes: config.ttlMinutes, purpose, setupId: config.id },
      machine: event.machine as unknown as Record<string, unknown> | undefined,
      lastError: event.error, retryCount: retry?.retryCount ?? 0,
      createdAt: attempt?.createdAt ?? createdAt, updatedAt: new Date().toISOString(),
    });
  };
  try {
    const machine = await launcher(
      {
        provider: config.provider,
        attemptId,
        onLifecycle,
        reuseNodeId: retry?.nodeId,
        externalTeardownGuaranteed: true,
        region: config.region,
        size: config.size,
        image: config.image,
        ttlMinutes: config.ttlMinutes,
        hostedTasks: true,
        githubToken,
        hostedMint: useHostedMint,
        setupId: config.id,
        purpose,
        name: `Hosted ${config.name}`,
      },
      { store: localStore, exec: directExec(), keys: serverKeyStore(providerToken), machines: serverMachineStore(store, accountId, nowMs) },
    );
    // Custom/injected launchers may not emit callbacks. Production launchers do;
    // once accepted, preserve the provider identity before any later bookkeeping.
    if (attempt) {
      attempt = await store.putHostedMachineAttempt({ ...attempt, state: "tracked", machine: machine as unknown as Record<string, unknown>, updatedAt: new Date().toISOString() });
    }
    await audit(store, accountId, { action: "provision_launched", provider: config.provider, configId: config.id, nodeId: machine.nodeId });
    // Gap 3: escrow the room key the control plane just generated, sealed at rest
    // with this account's hosted-provisioning key, keyed by the (reusable) node id.
    // This is what lets a later HOSTED, device-offline rebuild decrypt the session
    // snapshot — see provisionEphemeralRestore. Hosted-only by construction (this
    // function requires a hosted provider token); the CP never sees the plaintext
    // key on the wire and never exposes it to any client.
    if (roomKeyB64 && machine.nodeId) {
      await store.setNodeRoomKeyEnc(accountId, machine.nodeId, encryptSecret(accountId, roomKeyB64));
      await audit(store, accountId, { action: "room_key_escrowed", provider: config.provider, configId: config.id, nodeId: machine.nodeId });
    }
    return machine;
  } catch (e) {
    if (attempt && attempt.state !== "failed") {
      await store.putHostedMachineAttempt({ ...attempt, state: "failed", lastError: String((e as Error)?.message || e).slice(0, 500), updatedAt: new Date().toISOString() }).catch(() => {});
    }
    await audit(store, accountId, { action: "provision_failed", provider: config.provider, configId: config.id, detail: String((e as Error)?.message || e).slice(0, 200) });
    throw e;
  }
}

async function routePendingWorkToMachine(store: MeshStore, accountId: string, target: EphemeralNodeConfig, machine: EphemeralMachine): Promise<void> {
  if (!machine.nodeId) return;
  const routing = await store.getQueueRouting(accountId);
  const sourceLabel = routing.primary.kind === "node" ? `bivy/${routing.primary.node}` : "bivy";
  const targetLabel = `bivy/${ephemeralNodeLabel(machine.nodeId)}`;
  const pending = (await store.listWorkItems(accountId, 100)).filter((item) => item.status === "pending" && item.label === sourceLabel);
  for (const item of pending) {
    const assigned = await store.assignWorkItem(accountId, item.id, { label: targetLabel, runtimeId: item.runtimeId, model: item.model, ephemeral: true });
    if (assigned) await audit(store, accountId, { action: "work_routed", provider: target.provider, configId: target.id, nodeId: machine.nodeId, workItemId: item.id, detail: targetLabel });
  }
}

/** Maintain at most one account-owned, credential-empty ready runner per opted-in
 * stable BYO config. Calls are serialized with the same lease as work claims. */
export async function ensureReadyCapacity(
  store: MeshStore,
  accountId: string,
  env: ProvisionEnv,
  launcher = launchEphemeralMachine,
): Promise<EphemeralMachine | null> {
  const holder = `capacity:${randomUUID()}`;
  if (!(await store.acquireHostedProvisionLease(accountId, holder, PROVISION_LEASE_SECONDS))) return null;
  const stopHeartbeat = startLeaseHeartbeat(store, accountId, holder);
  try {
    if (!ephemeralMachinesEnabled()) return null;
    const hosted = await store.getHostedProvisioning(accountId);
    if (!hosted.enabled) return null;
    const configs = await store.getEphemeralConfigs(accountId);
    let machines = await store.getHostedMachines(accountId);
    const eligible = configs.filter((c) => (c.readyCapacity ?? 0) > 0 && ephemeralCatalogEntry(c.provider)?.computeClass === "byo-cloud");
    for (const candidate of eligible) {
      const existing = machines.find((m) => m.setupId === candidate.id && m.purpose === "ready-capacity");
      if (!existing || readyMachineUsable(existing)) continue;
      if (typeof existing.nodeId === "string") await reapSettledHostedMachine(store, accountId, existing.nodeId, env);
      machines = await store.getHostedMachines(accountId);
    }
    const config = eligible.find((c) => !machines.some((m) => m.setupId === c.id && m.purpose === "ready-capacity"));
    if (!config) return null;
    const token = hosted.providerTokens?.[config.provider];
    if (!token || hosted.validatedProviders?.[config.provider] !== providerCredentialFingerprint(token)) return null;
    const recentLaunches = (await store.listHostedAudit(accountId, 100)).filter((event) => event.action === "provision_launched" && withinMs(event.at, DEDUPE_WINDOW_MS, Date.now()));
    if (recentLaunches.length >= MAX_PROVISIONS_PER_HOUR) return null;
    const machine = await provisionEphemeralForAccount(store, accountId, config, env, launcher, Date.now(), "ready-capacity");
    await audit(store, accountId, { action: "capacity_ready", provider: config.provider, configId: config.id, nodeId: machine.nodeId });
    return machine;
  } finally {
    stopHeartbeat();
    await store.releaseHostedProvisionLease(accountId, holder).catch(() => {});
  }
}

export async function reconcileAllReadyCapacity(store: MeshStore, env: ProvisionEnv): Promise<{ accounts: number; created: number; failed: number }> {
  const accountIds = await store.listReadyCapacityAccountIds();
  const result = { accounts: accountIds.length, created: 0, failed: 0 };
  for (const accountId of accountIds) {
    try { if (await ensureReadyCapacity(store, accountId, env)) result.created++; }
    catch { result.failed++; }
  }
  return result;
}

/**
 * Restore-mode hosted provision (Gap 3): rebuild a torn-down session server-side
 * when NO device is online. Reuses the old eph-* node id and the ESCROWED session
 * room key (decrypted here) so the freshly-provisioned machine adopts that key
 * (relay.json `e2eKey` → PairingStore.load) and its daemon restores the session
 * snapshot via BIVY_RESTORE. The control plane never decrypts the snapshot itself
 * — it only hands the key to the machine it launches. Hosted-only: requires the
 * account's stored provider token and a previously escrowed room key.
 */
export async function provisionEphemeralRestore(
  store: MeshStore,
  accountId: string,
  config: EphemeralNodeConfig,
  env: ProvisionEnv,
  opts: { reuseNodeId: string; restoreSessionId: string },
  launcher = launchEphemeralMachine,
  nowMs = Date.now(),
): Promise<EphemeralMachine> {
  const hosted = await store.getHostedProvisioning(accountId);
  const providerToken = hosted.providerTokens?.[config.provider];
  if (!providerToken) throw new Error(`No hosted provider token for ${config.provider}`);
  const enc = await store.getNodeRoomKeyEnc(accountId, opts.reuseNodeId);
  if (!enc) throw new Error(`No escrowed room key for ${opts.reuseNodeId} — cannot rebuild this session server-side`);
  const reuseRoomKeyB64 = decryptSecret(accountId, enc);
  const useHostedMint = Boolean(hosted.githubApp);
  const githubToken = useHostedMint ? undefined : hosted.githubToken;
  await audit(store, accountId, { action: "provision_attempt", provider: config.provider, configId: config.id });

  const sessionToken = await store.createSession(accountId);
  const localStore = serverLocalStore({ sessionToken, env, onAddKey: () => {} });
  try {
    const machine = await launcher(
      {
        provider: config.provider,
        region: config.region,
        size: config.size,
        image: config.image,
        ttlMinutes: config.ttlMinutes,
        hostedTasks: true,
        externalTeardownGuaranteed: true,
        githubToken,
        hostedMint: useHostedMint,
        setupId: config.id,
        purpose: "queue-default",
        name: `Hosted ${config.name}`,
        // Rebuild the torn-down session in place: same node id + room key + session.
        reuseNodeId: opts.reuseNodeId,
        reuseRoomKeyB64,
        restoreSessionId: opts.restoreSessionId,
      },
      { store: localStore, exec: directExec(), keys: serverKeyStore(providerToken), machines: serverMachineStore(store, accountId, nowMs) },
    );
    await audit(store, accountId, { action: "room_key_reused", provider: config.provider, configId: config.id, nodeId: machine.nodeId });
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

/** Actively destroy one tracked hosted machine at its provider (and unenroll its
 *  node + forget its record via core's `destroyEphemeralMachine`). This is the
 *  key path for providers that DON'T self-reap on daemon exit — Hetzner halts but
 *  the server keeps billing until an explicit DELETE — and is idempotent /
 *  404-tolerant for Fly/EC2 that may already be gone. */
export type DestroyFn = typeof destroyEphemeralMachine;
export type ObserveFn = (machine: EphemeralMachine, providerToken: string) => Promise<string>;

const observeProviderMachine: ObserveFn = async (machine, providerToken) => {
  const adapter = ephemeralAdapter(machine.provider);
  if (!adapter) throw new Error(`unknown provider ${machine.provider}`);
  return adapter.status({ exec: directExec(), token: providerToken, machine });
};

async function destroyOneHostedMachine(
  store: MeshStore,
  accountId: string,
  machine: EphemeralMachine,
  providerToken: string,
  env: ProvisionEnv,
  nowMs: number,
  destroy: DestroyFn,
): Promise<void> {
  const sessionToken = await store.createSession(accountId);
  const localStore = serverLocalStore({ sessionToken, env, onAddKey: () => {} });
  await destroy(machine, {
    store: localStore,
    exec: directExec(),
    keys: serverKeyStore(providerToken),
    machines: serverMachineStore(store, accountId, nowMs),
  });
}

/**
 * A hosted machine reported it has settled (POST /node/settled) once its daemon
 * went idle — reap it now at the provider. This gives PROMPT teardown for
 * providers that don't self-destruct on daemon exit (Hetzner), well before the
 * TTL backstop; for Fly/EC2 (already reaped by daemon exit) it's a harmless,
 * 404-tolerant no-op. Returns true when a tracked hosted machine existed for the
 * node (device-launched machines aren't tracked server-side → false, and the
 * endpoint simply 200s).
 */
export async function reapSettledHostedMachine(
  store: MeshStore,
  accountId: string,
  nodeId: string,
  env: ProvisionEnv,
  nowMs = Date.now(),
  destroy: DestroyFn = destroyEphemeralMachine,
): Promise<boolean> {
  const machines = await store.getHostedMachines(accountId);
  const record = machines.find((m) => m.nodeId === nodeId);
  if (!record) return false;
  const machine = record as unknown as EphemeralMachine;
  const hosted = await store.getHostedProvisioning(accountId);
  const providerToken = hosted.providerTokens?.[machine.provider];
  try {
    if (providerToken) {
      await destroyOneHostedMachine(store, accountId, machine, providerToken, env, nowMs, destroy);
      if (machine.attemptId) {
        const attempt = await store.getHostedMachineAttempt(accountId, machine.attemptId).catch(() => undefined);
        if (attempt) await store.putHostedMachineAttempt({ ...attempt, state: "deleted", machine: machine as unknown as Record<string, unknown>, updatedAt: new Date(nowMs).toISOString() }).catch(() => {});
      }
      await audit(store, accountId, { action: "machine_reaped", provider: machine.provider, nodeId, detail: "settled — destroyed" });
    } else {
      // Missing credentials are not proof that the provider resource is gone.
      // Keep the record visible so restoring the credential permits a retry;
      // silently forgetting it could orphan a still-billing VM.
      await audit(store, accountId, {
        action: "reconcile_failed",
        provider: machine.provider,
        nodeId,
        detail: "provider credential unavailable; resource retained for retry",
      });
    }
  } catch (e) {
    await audit(store, accountId, { action: "provision_failed", nodeId, detail: `settled reap: ${String((e as Error)?.message || e).slice(0, 120)}` });
  }
  return true;
}

/**
 * Server-side lifecycle reconciliation for machines past their TTL grace. When
 * `env` is supplied and a hosted provider token exists, it ACTIVELY destroys the
 * machine at the provider (so leak-prone Hetzner servers don't bill past TTL);
 * otherwise it falls back to bookkeeping only (drop the record + unenroll the
 * node — the VM self-destructs at its own TTL for Fly/EC2). Returns the number
 * reaped. Safe to run lazily or on a timer.
 */
export async function reconcileHostedMachines(store: MeshStore, accountId: string, nowMs = Date.now(), env?: ProvisionEnv, destroy: DestroyFn = destroyEphemeralMachine, observe: ObserveFn = observeProviderMachine): Promise<number> {
  let machines = await store.getHostedMachines(accountId);
  // Older self-hosted/test store shims may not expose the new attempt table
  // until their migration completes; legacy tracked-machine cleanup must still run.
  const attempts = store.listHostedMachineAttempts
    ? await store.listHostedMachineAttempts(accountId, true).catch(() => [])
    : [];

  // Recover the crash window after provider acceptance but before legacy
  // inventory tracking. The attempt row was committed first and contains the
  // provider identity, so reconciliation can adopt it without another create.
  let adopted = false;
  for (const attempt of attempts) {
    if (!attempt.machine || machines.some((m) => m.attemptId === attempt.attemptId || (m.id && m.id === attempt.machine?.id))) continue;
    machines.push({ ...attempt.machine, attemptId: attempt.attemptId, nodeId: attempt.nodeId, setupId: attempt.configId });
    await store.putHostedMachineAttempt({ ...attempt, state: "tracked", updatedAt: new Date(nowMs).toISOString() });
    adopted = true;
  }
  if (adopted) await store.setHostedMachines(accountId, machines);

  // Retry pre-acceptance attempts with the SAME attempt/node identity. Provider
  // adapters first discover by the attempt tag (and EC2 uses ClientToken), so an
  // accepted create whose response was lost is adopted, never duplicated.
  if (env && attempts.length) {
    const configs = await store.getEphemeralConfigs(accountId);
    for (const attempt of attempts) {
      if (attempt.machine || !["requested", "enrolled", "failed"].includes(attempt.state)) continue;
      const age = nowMs - Date.parse(attempt.updatedAt);
      const backoff = Math.min(15 * 60_000, 30_000 * 2 ** Math.min(attempt.retryCount, 5));
      if (!Number.isFinite(age) || age < backoff) continue;
      const config = configs.find((c) => c.id === attempt.configId) ?? {
        id: attempt.configId || `recovered-${attempt.attemptId}`,
        name: "Recovered ephemeral runner",
        provider: attempt.provider,
        region: typeof attempt.desired.region === "string" ? attempt.desired.region : undefined,
        size: typeof attempt.desired.size === "string" ? attempt.desired.size : undefined,
        image: typeof attempt.desired.image === "string" ? attempt.desired.image : undefined,
        ttlMinutes: typeof attempt.desired.ttlMinutes === "number" ? attempt.desired.ttlMinutes : 60,
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt,
      };
      const retryCount = attempt.retryCount + 1;
      await store.putHostedMachineAttempt({ ...attempt, state: "requested", retryCount, lastError: undefined, updatedAt: new Date(nowMs).toISOString() });
      await provisionEphemeralForAccount(store, accountId, config, env, launchEphemeralMachine, nowMs, (attempt.desired.purpose as EphemeralMachine["purpose"]) || "queue-default", { attemptId: attempt.attemptId, nodeId: attempt.nodeId, retryCount }).catch(() => {});
    }
    machines = await store.getHostedMachines(accountId);
  }

  if (!machines.length && !attempts.length) return 0;
  const hosted = env ? await store.getHostedProvisioning(accountId) : null;
  const kept: Array<Record<string, unknown>> = [];
  let reaped = 0;
  let inventoryChanged = adopted;
  for (const original of machines) {
    let m = original;
    const createdAt = typeof m.createdAt === "string" ? Date.parse(m.createdAt) : NaN;
    const ttlMin = typeof m.ttlMinutes === "number" ? m.ttlMinutes : 60;
    const nodeId = typeof m.nodeId === "string" ? m.nodeId : "";
    const provider = typeof m.provider === "string" ? m.provider : "";
    const providerToken = env && provider ? hosted?.providerTokens?.[provider] : undefined;

    // Attempts opt into active observation. Legacy rows remain TTL-reconciled so
    // upgrades do not suddenly fan out provider calls for old inventory.
    if (env && providerToken && typeof m.attemptId === "string") {
      try {
        const observed = await observe(m as unknown as EphemeralMachine, providerToken);
        if (observed === "gone") {
          if (nodeId) await store.removeNode(accountId, nodeId).catch(() => {});
          const attempt = await store.getHostedMachineAttempt(accountId, m.attemptId).catch(() => undefined);
          if (attempt) await store.putHostedMachineAttempt({ ...attempt, state: "deleted", machine: m, updatedAt: new Date(nowMs).toISOString() }).catch(() => {});
          reaped++;
          inventoryChanged = true;
          await audit(store, accountId, { action: "machine_reaped", provider, nodeId: nodeId || undefined, detail: "provider confirmed gone" });
          continue;
        }
        if (observed !== m.status) {
          m = { ...m, status: observed };
          inventoryChanged = true;
        }
      } catch (error) {
        await audit(store, accountId, { action: "reconcile_failed", provider, nodeId: nodeId || undefined, detail: `provider observe: ${String((error as Error)?.message || error).slice(0, 120)}` });
      }
    }

    const ttlGraceMs = (ttlMin + 15) * 60 * 1000;
    const bootDeadlineMs = 15 * 60 * 1000;
    const nodeReady = typeof (m.milestones as Record<string, unknown> | undefined)?.nodeReadyAt === "string";
    const bootTimedOut = typeof m.attemptId === "string" && Number.isFinite(createdAt) && !nodeReady && nowMs - createdAt > bootDeadlineMs;
    if (Number.isFinite(createdAt) && nowMs - createdAt <= ttlGraceMs && !bootTimedOut) {
      kept.push(m);
      continue;
    }
    if (env && providerToken) {
      try {
        await destroyOneHostedMachine(store, accountId, m as unknown as EphemeralMachine, providerToken, env, nowMs, destroy);
      } catch (error) {
        // Never forget a resource whose provider deletion failed: it may still
        // be billing, and retaining the record lets the next sweep retry.
        kept.push(m);
        await audit(store, accountId, {
          action: "reconcile_failed",
          provider: provider || undefined,
          nodeId: nodeId || undefined,
          detail: `provider destroy: ${String((error as Error)?.message || error).slice(0, 120)}`,
        });
        continue;
      }
    } else if (env) {
      // A hosted resource without a usable provider credential cannot be proven
      // deleted. Keep tracking it so credential repair allows a later retry.
      kept.push(m);
      await audit(store, accountId, {
        action: "reconcile_failed",
        provider: provider || undefined,
        nodeId: nodeId || undefined,
        detail: "provider credential unavailable; resource retained for retry",
      });
      continue;
    } else if (nodeId) {
      try {
        await store.removeNode(accountId, nodeId);
      } catch {
        /* best effort — Fly/EC2 self-destruct regardless */
      }
    }
    reaped++;
    const attemptId = typeof m.attemptId === "string" ? m.attemptId : "";
    if (attemptId) {
      const attempt = await store.getHostedMachineAttempt(accountId, attemptId).catch(() => undefined);
      if (attempt) await store.putHostedMachineAttempt({ ...attempt, state: "deleted", machine: m, updatedAt: new Date(nowMs).toISOString() }).catch(() => {});
    }
    inventoryChanged = true;
    await audit(store, accountId, { action: "machine_reaped", nodeId: nodeId || undefined, detail: `${bootTimedOut ? "boot deadline exceeded" : `ttl ${ttlMin}m elapsed`}${env && providerToken ? " — destroyed" : ""}` });
  }
  if (inventoryChanged || reaped) await store.setHostedMachines(accountId, kept);
  return reaped;
}

export interface ReconcileAllResult {
  accounts: number;
  reaped: number;
  failed: number;
}

/** Sweep every account with tracked hosted machines. This is the TTL leak
 * backstop when no new work arrives and a runner never sends /node/settled.
 * Accounts are isolated: one provider/store failure cannot stop the rest. */
export async function reconcileAllHostedMachines(
  store: MeshStore,
  env: ProvisionEnv,
  nowMs = Date.now(),
  destroy: DestroyFn = destroyEphemeralMachine,
): Promise<ReconcileAllResult> {
  const accountIds = await store.listHostedMachineAccountIds();
  const result: ReconcileAllResult = { accounts: accountIds.length, reaped: 0, failed: 0 };
  for (const accountId of accountIds) {
    try {
      result.reaped += await reconcileHostedMachines(store, accountId, nowMs, env, destroy);
    } catch (error) {
      result.failed++;
      await audit(store, accountId, {
        action: "reconcile_failed",
        detail: String((error as Error)?.message || error).slice(0, 160),
      });
    }
  }
  return result;
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
  const leaseHolder = randomUUID();
  let replenish = false;
  let stopHeartbeat: (() => void) | undefined;
  try {
    // Lazy lifecycle reconciliation: prune (and actively destroy leak-prone)
    // machines past TTL before deciding, so dedupe/rate-cap see fresh state and
    // node slots are freed. Passing env lets it DELETE the provider resource
    // (Hetzner) rather than only forgetting the record.
    await reconcileHostedMachines(store, accountId, Date.now(), env).catch(() => {});
    // Planning and launching must be one cross-replica critical section. Without
    // this lease, two webhook/control-plane workers can both observe no active
    // machine and each create a separately billed VM. Five minutes covers slow
    // compatibility boot APIs; expiry recovers automatically after a crash.
    if (!(await store.acquireHostedProvisionLease(accountId, leaseHolder, PROVISION_LEASE_SECONDS))) return null;
    stopHeartbeat = startLeaseHeartbeat(store, accountId, leaseHolder);
    const routing = await store.getQueueRouting(accountId);
    const configs = await store.getEphemeralConfigs(accountId);
    const target = resolveAutoProvisionTarget(routing, configs);
    if (target) {
      const machines = await store.getHostedMachines(accountId);
      const ready = machines.find((m) => m.setupId === target.id && m.purpose === "ready-capacity"
        && readyMachineUsable(m)
        && typeof (m.milestones as Record<string, unknown> | undefined)?.nodeReadyAt === "string");
      const sourceLabel = routing.primary.kind === "node" ? `bivy/${routing.primary.node}` : "bivy";
      const hasPending = (await store.listWorkItems(accountId, 100)).some((item) => item.status === "pending" && item.label === sourceLabel);
      if (ready && hasPending) {
        const claimed = { ...ready, purpose: "queue-default", claimedAt: new Date().toISOString() };
        // Route first. If the controller crashes afterward the work still reaches
        // this unique runner; the inverse order strands paid claimed capacity.
        await routePendingWorkToMachine(store, accountId, target, claimed as unknown as EphemeralMachine);
        await store.setHostedMachines(accountId, machines.map((m) => m.id === ready.id ? claimed : m));
        if (typeof ready.attemptId === "string") {
          const attempt = await store.getHostedMachineAttempt(accountId, ready.attemptId).catch(() => undefined);
          if (attempt) await store.putHostedMachineAttempt({ ...attempt, state: "claimed", machine: claimed, updatedAt: new Date().toISOString() }).catch(() => {});
        }
        await audit(store, accountId, { action: "capacity_claimed", provider: target.provider, configId: target.id, nodeId: typeof ready.nodeId === "string" ? ready.nodeId : undefined });
        replenish = true;
        return claimed as unknown as EphemeralMachine;
      }
    }
    const plan = await planAutoProvision(store, accountId);
    if (!plan.willProvision || !plan.targetConfigId) return null;
    const plannedTarget = configs.find((c) => c.id === plan.targetConfigId);
    if (!plannedTarget) return null;
    // Case B + Gap 3: if a pending item wants to CONTINUE an existing session whose
    // (torn-down) node still has an escrowed room key, rebuild that session in place
    // server-side rather than launching a blank machine. Best-effort — any gap
    // (no correlation / no escrowed key) falls back to a normal fresh provision.
    const restore = await planRestoreProvision(store, accountId).catch(() => null);
    const machine = restore
      ? await provisionEphemeralRestore(store, accountId, plannedTarget, env, restore, launcher)
      : await provisionEphemeralForAccount(store, accountId, plannedTarget, env, launcher);
    // A hosted runner serves its unique `bivy/<eph suffix>` label. Move only
    // work that was waiting on the routing target which caused this launch;
    // explicit items for another node/config must remain untouched.
    await routePendingWorkToMachine(store, accountId, plannedTarget, machine);
    return machine;
  } catch (e) {
    console.error(`[hosted-provision] account ${accountId}:`, (e as Error)?.message || e);
    return null;
  } finally {
    stopHeartbeat?.();
    await store.releaseHostedProvisionLease(accountId, leaseHolder).catch(() => {});
    if (replenish) void ensureReadyCapacity(store, accountId, env, launcher).catch(() => {});
  }
}
