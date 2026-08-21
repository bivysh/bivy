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
import {
  providerCredentialFingerprint,
  ownershipTagFor,
  ConcurrentAttemptUpdateError,
  type EphemeralConfigurationRepository,
  type HostedMachineRepository,
  type ComputeUsageRepository,
  type EphemeralNodeConfig,
  type QueueRouting,
  type HostedAuditEvent,
  type HostedMachineAttempt,
  type HostedMachineAttemptState,
  type HostedProvisioning,
  type NodeRecord,
  type SessionCorrelation,
  type WorkItem,
} from "./store.js";
import {
  managedComputeEnabled,
  normalizeComputeSource,
  operatorTokenSource,
  type ComputeSource,
} from "./managed-compute.js";
import type { SecretEnvelope } from "./hosted-crypto.js";
import { mintInstallationToken } from "./hosted-github-auth.js";
import { encryptSecret, decryptSecret } from "./hosted-crypto.js";
import { centralGithubAppConfig, resolveGithubIdentity, type ResolvedGithubIdentity } from "./central-github-app.js";
import type { CentralGithubInstallation } from "./store.js";
import { usageFromManagedMachine } from "./compute-metering.js";

/** Persistence needed by unattended machine orchestration. Deliberately omits
 * account administration, notifications, device vaults, and automation
 * definition management even though the concrete adapter provides them. */
export interface EphemeralProvisioningPort
  extends EphemeralConfigurationRepository, HostedMachineRepository, ComputeUsageRepository {
  createSession(accountId: string): Promise<string>;
  getAccount(accountId: string): Promise<import("./store.js").Account | undefined>;
  listNodes(accountId: string): Promise<NodeRecord[]>;
  removeNode(accountId: string, nodeId: string): Promise<boolean>;
  listWorkItems(accountId: string, limit?: number): Promise<WorkItem[]>;
  assignWorkItem(
    accountId: string,
    id: string,
    input: { label: string; runtimeId?: string; model?: string; ephemeral?: boolean },
  ): Promise<WorkItem | undefined>;
  getSessionCorrelation(accountId: string, sessionId: string): Promise<SessionCorrelation | undefined>;
  getNodeRoomKeyEnc(accountId: string, nodeId: string): Promise<SecretEnvelope | undefined>;
  setNodeRoomKeyEnc(accountId: string, nodeId: string, enc: SecretEnvelope): Promise<void>;
  /** Central-app installations bound to the account. Optional so narrow test
   *  fakes keep compiling; absent = the central-app identity never resolves. */
  listCentralGithubInstallations?(accountId: string): Promise<CentralGithubInstallation[]>;
}

/** The account's GitHub identity, resolved through the ONE mode table in
 *  central-github-app.ts (own app / PAT / central app installation). */
async function resolveAccountGithubIdentity(
  store: EphemeralProvisioningPort,
  accountId: string,
  hosted: HostedProvisioning,
  repo?: string,
): Promise<ResolvedGithubIdentity | null> {
  const central = centralGithubAppConfig();
  const centralInstallations =
    central && store.listCentralGithubInstallations ? await store.listCentralGithubInstallations(accountId) : [];
  return resolveGithubIdentity({ hosted, central, centralInstallations }, repo);
}

export interface ProvisionEnv {
  /** Public control-plane base URL the booted machine enrolls/reports to. */
  cpBaseUrl: string;
  /** Relay URL baked into the machine's cloud-init bootstrap. */
  relayUrl: string;
}

export interface ManagedProvisionRequest {
  attemptId?: string;
  computeSource: "managed";
  provider: string;
  sizeId?: string;
  vcpus?: number;
  memoryMiB?: number;
  ttlMinutes: number;
  configId: string;
  purpose?: string;
}

export interface ProvisionAdmissionDecision {
  allowed: boolean;
  code?: string;
  reason?: string;
}

export type ManagedProvisionAdmission = (request: ManagedProvisionRequest) => Promise<ProvisionAdmissionDecision>;
const allowManagedProvision: ManagedProvisionAdmission = async () => ({ allowed: true });

export interface ProvisionPlan {
  willProvision: boolean;
  targetConfigId: string | null;
  reason: string;
  policyDenial?: ProvisionAdmissionDecision;
}

export interface HostedExecutionReadiness { ready: boolean; reason: string; configId?: string }

/** Static account capability for automation UI. Unlike planAutoProvision this
 * does not inspect pending work, active machines, rate limits, or node liveness. */
export async function hostedExecutionReadiness(store: EphemeralProvisioningPort, accountId: string): Promise<HostedExecutionReadiness> {
  if (!ephemeralMachinesEnabled()) return { ready: false, reason: "deployment emergency switch is off" };
  const hosted = await store.getHostedProvisioning(accountId);
  if (!hosted.enabled) return { ready: false, reason: "unattended provisioning is disabled" };
  const routing = await store.getQueueRouting(accountId);
  const config = resolveAutoProvisionTarget(routing, await store.getEphemeralConfigs(accountId));
  if (!config) return { ready: false, reason: "automation routing has no ephemeral config" };
  if (!ephemeralAdapter(config.provider)) return { ready: false, reason: `provider ${config.provider} is no longer supported`, configId: config.id };
  if (normalizeComputeSource(config.computeSource) === "managed") {
    if (!managedComputeEnabled()) return { ready: false, reason: "managed compute is disabled (MANAGED_COMPUTE_ENABLED)", configId: config.id };
    const cred = await resolveProviderCredential(hosted, config.provider, "managed");
    if (!cred.token) return { ready: false, reason: cred.reason, configId: config.id };
    return { ready: true, reason: "hosted ephemeral execution is ready", configId: config.id };
  }
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
  store: EphemeralProvisioningPort,
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
        const ttlMinutes = typeof attempt.desired?.ttlMinutes === "number" ? attempt.desired.ttlMinutes : undefined;
        const deadlineAt = computeAttemptDeadline(state, typeof machine?.createdAt === "string" ? machine.createdAt : attempt.createdAt, ttlMinutes, Date.parse(at) || Date.now());
        await store.putHostedMachineAttempt({ ...attempt, state, machine, deadlineAt, updatedAt: at }).catch(() => {});
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
const BOOT_DEADLINE_MS = 15 * 60 * 1000;
const TTL_GRACE_MS = 15 * 60 * 1000;
// An attempt that has never reached the provider gets this many retries (with
// exponential backoff between each) before the reconciler gives up and
// unenrolls its node rather than retrying forever — see the retry loop in
// `reconcileHostedMachines`.
const MAX_ATTEMPT_RETRIES = 8;

/** The next moment this attempt should be forced to a new state if nothing
 * else happens — persisted (`HostedMachineAttempt.deadlineAt`) so a restart
 * or the UI don't need to recompute it from scattered fields. Pre-boot phases
 * are bounded by the boot deadline (measured from the resource's own
 * `createdAt` once known, else now); phases past first-ready are bounded by
 * TTL + grace. Terminal phases have no future deadline. */
function computeAttemptDeadline(
  phase: HostedMachineAttemptState,
  createdAtIso: string | undefined,
  ttlMinutes: number | undefined,
  nowMs: number,
): string | undefined {
  if (phase === "deleted" || phase === "failed" || phase === "deleting") return undefined;
  const createdAtMs = createdAtIso ? Date.parse(createdAtIso) : NaN;
  const base = Number.isFinite(createdAtMs) ? createdAtMs : nowMs;
  if (phase === "ready" || phase === "claimed" || phase === "working") {
    return new Date(base + (ttlMinutes ?? 60) * 60 * 1000 + TTL_GRACE_MS).toISOString();
  }
  return new Date(base + BOOT_DEADLINE_MS).toISOString();
}

/** Keep a cross-replica provision lease alive while a slow provider call is in
 * flight. Without renewal, expiry permits a second replica to launch another
 * paid machine while the first request is merely slow. `isLost()` fences the
 * critical section that follows: an in-flight provider HTTP call can't be
 * cancelled once sent, but a caller can (and does, see `maybeAutoProvision`)
 * refuse to COMMIT a claim/route write once it knows a second holder may
 * already own the account. */
function startLeaseHeartbeat(store: EphemeralProvisioningPort, accountId: string, holder: string): { stop: () => void; isLost: () => boolean } {
  let lost = false;
  const timer = setInterval(() => {
    void store.renewHostedProvisionLease(accountId, holder, PROVISION_LEASE_SECONDS).then((owned) => {
      if (!owned) {
        lost = true;
        console.error(`[hosted-provision] lost lease account=${accountId} holder=${holder}`);
      }
    }).catch((error) => console.error(`[hosted-provision] lease renewal failed account=${accountId}:`, error));
  }, 60_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer), isLost: () => lost };
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

/**
 * Resolve the transient provider credential for one launch/teardown by compute
 * source — the ONE place the user and managed lanes differ. "user" reads the
 * account's hosted token (optionally requiring the onboarding validation
 * fingerprint, as planAutoProvision always has); "managed" reads the
 * deployment's operator token source. The returned token is used exactly like
 * hosted.providerTokens always was: transiently, never persisted, never logged,
 * never baked into machine user-data, never returned by an API.
 */
async function resolveProviderCredential(
  hosted: HostedProvisioning,
  provider: string,
  source: ComputeSource,
  opts: { requireValidated?: boolean } = {},
): Promise<{ token?: string; reason: string }> {
  if (source === "managed") {
    const token = await operatorTokenSource().getToken(provider);
    if (!token) return { reason: `no operator token for provider ${provider} (managed lane)` };
    return { token, reason: "ok" };
  }
  const token = hosted.providerTokens?.[provider];
  if (!token) return { reason: `no hosted token for provider ${provider}` };
  if (opts.requireValidated && hosted.validatedProviders?.[provider] !== providerCredentialFingerprint(token)) {
    return { reason: `provider credential for ${provider} has not been validated` };
  }
  return { token, reason: "ok" };
}

/** Compute source of an already-created machine, for teardown-token selection.
 * The attempt row's `desired.computeSource` is authoritative (durable from
 * before provider acceptance); the config is the fallback for records that
 * predate attempts. Legacy records resolve to "user". */
function machineComputeSource(
  machine: Record<string, unknown>,
  attempt: HostedMachineAttempt | undefined,
  configs: EphemeralNodeConfig[],
): ComputeSource {
  if (attempt?.desired && "computeSource" in attempt.desired) return normalizeComputeSource(attempt.desired.computeSource);
  const setupId = typeof machine.setupId === "string" ? machine.setupId : "";
  const config = setupId ? configs.find((c) => c.id === setupId) : undefined;
  return normalizeComputeSource(config?.computeSource);
}

function withinMs(iso: unknown, ms: number, nowMs: number): boolean {
  if (typeof iso !== "string") return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && nowMs - t < ms;
}

// Best-effort append to the account's hosted-credential audit trail. `at` is
// stamped here; failures never block provisioning.
async function audit(store: EphemeralProvisioningPort, accountId: string, event: Omit<HostedAuditEvent, "at">): Promise<void> {
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
export async function planAutoProvision(
  store: EphemeralProvisioningPort,
  accountId: string,
  nowMs = Date.now(),
  admitManaged: ManagedProvisionAdmission = allowManagedProvision,
  managedAttemptId?: string,
): Promise<ProvisionPlan> {
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
  const adapter = ephemeralAdapter(target.provider);
  if (!adapter) {
    return { willProvision: false, targetConfigId: target.id, reason: `provider ${target.provider} is no longer supported` };
  }
  const computeSource = normalizeComputeSource(target.computeSource);
  // Managed-lane kill switch: default OFF, gates NEW launches only. Cleanup /
  // reconcile / orphan sweeps intentionally do not consult it (mirroring
  // EPHEMERAL_MACHINES_ENABLED above), so flipping it off never strands a
  // billing machine.
  if (computeSource === "managed" && !managedComputeEnabled()) {
    return { willProvision: false, targetConfigId: target.id, reason: "managed compute disabled (MANAGED_COMPUTE_ENABLED)" };
  }
  const cred = await resolveProviderCredential(hosted, target.provider, computeSource, { requireValidated: true });
  if (!cred.token) {
    return { willProvision: false, targetConfigId: target.id, reason: cred.reason };
  }
  // The one operator-policy seam for Bivy-paid compute. Core supplies only
  // technical facts; a configured deployment extension owns tiers, trials,
  // commercial usage and upgrade actions. BYO never crosses this gate.
  if (computeSource === "managed") {
    const sizeId = target.size ?? adapter.defaultSize;
    const size = sizeId ? adapter.sizes.find((entry) => entry.id === sizeId) : undefined;
    const decision = await admitManaged({
      attemptId: managedAttemptId,
      computeSource: "managed",
      provider: target.provider,
      sizeId,
      vcpus: size?.vcpus,
      memoryMiB: size?.memoryMiB,
      ttlMinutes: target.ttlMinutes ?? 60,
      configId: target.id,
      purpose: "queue-work",
    });
    if (!decision.allowed) {
      return {
        willProvision: false,
        targetConfigId: target.id,
        reason: decision.reason ?? "Managed compute was denied by deployment policy",
        policyDenial: decision,
      };
    }
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
function serverMachineStore(
  store: EphemeralProvisioningPort,
  accountId: string,
  nowMs: number,
  computeSource?: ComputeSource,
): MachineStore {
  return {
    list: async () => (await store.getHostedMachines(accountId)) as unknown as EphemeralMachine[],
    add: async (m) => {
      const cur = await store.getHostedMachines(accountId);
      const recent = cur.filter((x) => withinMs(x.createdAt, 6 * 60 * 60 * 1000, nowMs));
      const record = computeSource ? { ...m, computeSource } : m;
      await store.setHostedMachines(accountId, [...recent, record as unknown as Record<string, unknown>]);
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
  store: EphemeralProvisioningPort,
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
  store: EphemeralProvisioningPort,
  accountId: string,
  config: EphemeralNodeConfig,
  env: ProvisionEnv,
  launcher = launchEphemeralMachine,
  nowMs = Date.now(),
  purpose: EphemeralMachine["purpose"] = "queue-default",
  retry?: { attemptId: string; nodeId?: string; retryCount: number },
): Promise<EphemeralMachine> {
  const hosted = await store.getHostedProvisioning(accountId);
  const computeSource = normalizeComputeSource(config.computeSource);
  const cred = await resolveProviderCredential(hosted, config.provider, computeSource);
  const providerToken = cred.token;
  if (!providerToken) throw new Error(computeSource === "managed" ? cred.reason : `No hosted provider token for ${config.provider}`);
  await audit(store, accountId, {
    action: "provision_attempt", provider: config.provider, configId: config.id,
    ...(computeSource === "managed" ? { detail: "computeSource=managed" } : {}),
  });

  // With an app identity (the account's own app OR the central app), the
  // machine self-mints a fresh, short-lived installation token from the control
  // plane per git op (BIVY_HOSTED_MINT) — no static credential is ever baked
  // into the machine, and long sessions keep working. With only a stored PAT,
  // inject it statically (the legacy fallback).
  const identity = await resolveAccountGithubIdentity(store, accountId, hosted);
  const useHostedMint = identity?.kind === "app";
  const githubToken = identity?.kind === "token" ? identity.token : undefined;

  // Enroll runs over HTTP against our own /nodes/enroll with this bearer.
  const sessionToken = await store.createSession(accountId);
  let roomKeyB64 = "";
  const localStore = serverLocalStore({ sessionToken, env, onAddKey: (_id, key) => { roomKeyB64 = key; } });
  const attemptId = retry?.attemptId ?? randomUUID();
  const createdAt = new Date(nowMs).toISOString();
  const ownershipTag = ownershipTagFor(accountId);
  let attempt: HostedMachineAttempt | undefined = retry ? await store.getHostedMachineAttempt(accountId, attemptId) : undefined;
  const onLifecycle = async (event: EphemeralLaunchEvent): Promise<void> => {
    const phase = event.phase as HostedMachineAttemptState;
    const eventCreatedAt = typeof event.machine?.createdAt === "string" ? event.machine.createdAt : undefined;
    attempt = await store.putHostedMachineAttempt({
      accountId, attemptId: event.attemptId, provider: config.provider, configId: config.id,
      nodeId: event.nodeId, state: phase,
      desiredState: attempt?.desiredState ?? "active",
      observedState: attempt?.observedState,
      deadlineAt: computeAttemptDeadline(phase, eventCreatedAt ?? attempt?.machine?.createdAt as string | undefined, config.ttlMinutes, Date.now()),
      ownershipTag,
      // computeSource rides in `desired` so teardown/reconcile can pick the
      // right credential lane even after the config itself is deleted.
      desired: { region: config.region, size: config.size, image: config.image, ttlMinutes: config.ttlMinutes, purpose, setupId: config.id, computeSource },
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
        ownershipTag,
        region: config.region,
        size: config.size,
        image: config.image,
        ttlMinutes: config.ttlMinutes,
        // Authentication runners exist only to establish encrypted provider
        // credentials. They must never poll or claim queued work, so no agent
        // event can accidentally consume a managed trial.
        hostedTasks: purpose !== "auth-runner",
        githubToken,
        hostedMint: useHostedMint,
        setupId: config.id,
        purpose,
        name: `Hosted ${config.name}`,
      },
      { store: localStore, exec: directExec(), keys: serverKeyStore(providerToken), machines: serverMachineStore(store, accountId, nowMs, computeSource) },
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

async function routePendingWorkToMachine(store: EphemeralProvisioningPort, accountId: string, target: EphemeralNodeConfig, machine: EphemeralMachine): Promise<void> {
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
  store: EphemeralProvisioningPort,
  accountId: string,
  env: ProvisionEnv,
  launcher = launchEphemeralMachine,
): Promise<EphemeralMachine | null> {
  const holder = `capacity:${randomUUID()}`;
  if (!(await store.acquireHostedProvisionLease(accountId, holder, PROVISION_LEASE_SECONDS))) return null;
  const heartbeat = startLeaseHeartbeat(store, accountId, holder);
  try {
    if (!ephemeralMachinesEnabled()) return null;
    const hosted = await store.getHostedProvisioning(accountId);
    if (!hosted.enabled) return null;
    const configs = await store.getEphemeralConfigs(accountId);
    let machines = await store.getHostedMachines(accountId);
    // Ready capacity stays a BYO/user-lane feature: pre-warming operator-paid
    // managed machines is idle spend on Bivy's bill, a call that belongs to the
    // metering/caps workstream (see the CAP GATE in planAutoProvision).
    const eligible = configs.filter((c) => (c.readyCapacity ?? 0) > 0
      && ephemeralCatalogEntry(c.provider)?.computeClass === "byo-cloud"
      && normalizeComputeSource(c.computeSource) === "user");
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
    heartbeat.stop();
    await store.releaseHostedProvisionLease(accountId, holder).catch(() => {});
  }
}

export async function reconcileAllReadyCapacity(store: EphemeralProvisioningPort, env: ProvisionEnv): Promise<{ accounts: number; created: number; failed: number }> {
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
  store: EphemeralProvisioningPort,
  accountId: string,
  config: EphemeralNodeConfig,
  env: ProvisionEnv,
  opts: { reuseNodeId: string; restoreSessionId: string; attemptId?: string; retryCount?: number },
  launcher = launchEphemeralMachine,
  nowMs = Date.now(),
): Promise<EphemeralMachine> {
  const hosted = await store.getHostedProvisioning(accountId);
  const computeSource = normalizeComputeSource(config.computeSource);
  const cred = await resolveProviderCredential(hosted, config.provider, computeSource);
  const providerToken = cred.token;
  if (!providerToken) throw new Error(computeSource === "managed" ? cred.reason : `No hosted provider token for ${config.provider}`);
  const enc = await store.getNodeRoomKeyEnc(accountId, opts.reuseNodeId);
  if (!enc) throw new Error(`No escrowed room key for ${opts.reuseNodeId} — cannot rebuild this session server-side`);
  const reuseRoomKeyB64 = decryptSecret(accountId, enc);
  const identity = await resolveAccountGithubIdentity(store, accountId, hosted);
  const useHostedMint = identity?.kind === "app";
  const githubToken = identity?.kind === "token" ? identity.token : undefined;
  await audit(store, accountId, {
    action: "provision_attempt", provider: config.provider, configId: config.id,
    ...(computeSource === "managed" ? { detail: "computeSource=managed" } : {}),
  });

  const sessionToken = await store.createSession(accountId);
  const localStore = serverLocalStore({ sessionToken, env, onAddKey: () => {} });
  const attemptId = opts.attemptId ?? randomUUID();
  const createdAt = new Date(nowMs).toISOString();
  const ownershipTag = ownershipTagFor(accountId);
  let attempt: HostedMachineAttempt | undefined = opts.attemptId ? await store.getHostedMachineAttempt(accountId, attemptId) : undefined;
  const onLifecycle = async (event: EphemeralLaunchEvent): Promise<void> => {
    const phase = event.phase as HostedMachineAttemptState;
    const eventCreatedAt = typeof event.machine?.createdAt === "string" ? event.machine.createdAt : undefined;
    attempt = await store.putHostedMachineAttempt({
      accountId, attemptId: event.attemptId, provider: config.provider, configId: config.id,
      nodeId: event.nodeId, state: phase,
      desiredState: attempt?.desiredState ?? "active",
      observedState: attempt?.observedState,
      deadlineAt: computeAttemptDeadline(phase, eventCreatedAt ?? attempt?.machine?.createdAt as string | undefined, config.ttlMinutes, Date.now()),
      ownershipTag,
      desired: { region: config.region, size: config.size, image: config.image, ttlMinutes: config.ttlMinutes, purpose: "queue-default", setupId: config.id, restoreSessionId: opts.restoreSessionId, computeSource },
      machine: event.machine as unknown as Record<string, unknown> | undefined,
      lastError: event.error, retryCount: opts.retryCount ?? 0,
      createdAt: attempt?.createdAt ?? createdAt, updatedAt: new Date().toISOString(),
    });
  };
  try {
    const machine = await launcher(
      {
        provider: config.provider,
        attemptId,
        onLifecycle,
        ownershipTag,
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
      { store: localStore, exec: directExec(), keys: serverKeyStore(providerToken), machines: serverMachineStore(store, accountId, nowMs, computeSource) },
    );
    if (attempt) await store.putHostedMachineAttempt({ ...attempt, state: "tracked", machine: machine as unknown as Record<string, unknown>, updatedAt: new Date().toISOString() });
    await audit(store, accountId, { action: "room_key_reused", provider: config.provider, configId: config.id, nodeId: machine.nodeId });
    await audit(store, accountId, { action: "provision_launched", provider: config.provider, configId: config.id, nodeId: machine.nodeId });
    return machine;
  } catch (e) {
    if (attempt && attempt.state !== "failed") await store.putHostedMachineAttempt({ ...attempt, state: "failed", lastError: String((e as Error)?.message || e).slice(0, 500), updatedAt: new Date().toISOString() }).catch(() => {});
    await audit(store, accountId, { action: "provision_failed", provider: config.provider, configId: config.id, detail: String((e as Error)?.message || e).slice(0, 200) });
    throw e;
  }
}

/**
 * Mint a fresh installation token for the account's resolved GitHub identity
 * (own app or the central app's installation). Used by the mint-on-demand
 * endpoint so a long-running machine can re-fetch a token per git op instead of
 * holding a long-lived one. The minted token is returned to the caller and
 * NEVER persisted. Returns null if hosted provisioning is off or the identity
 * resolves to no app (a stored PAT is injected at launch, not minted here).
 *
 * Isolation: the identity resolves only against installations the store has
 * bound to `accountId`, so one account can never mint for another's
 * installation. For the central app the token is additionally scoped down to
 * `opts.repo` where the API allows; GitHub rejects a repo outside the
 * installation, in which case the full-installation (still ~1h) token is used.
 */
export async function mintHostedInstallationToken(
  store: EphemeralProvisioningPort,
  accountId: string,
  opts?: { repo?: string; fetchImpl?: typeof fetch },
): Promise<{ token: string; expiresAt: string } | null> {
  const hosted = await store.getHostedProvisioning(accountId);
  if (!hosted.enabled) return null;
  const identity = await resolveAccountGithubIdentity(store, accountId, hosted, opts?.repo);
  if (identity?.kind !== "app") return null;
  const creds = { appId: identity.appId, installationId: identity.installationId, privateKeyPem: identity.privateKeyPem };
  const fetchImpl = opts?.fetchImpl ?? fetch;
  // Scope to the session repo for the central app only — a BYO app's
  // installation is already the user's own scoping choice.
  const repoName =
    identity.mode === "central-app" && opts?.repo?.includes("/") ? opts.repo.split("/")[1] : undefined;
  let minted: { token: string; expiresAt: string } | undefined;
  let scoped = false;
  if (repoName) {
    try {
      minted = await mintInstallationToken(creds, fetchImpl, undefined, { repositories: [repoName] });
      scoped = true;
    } catch {
      // repo outside the installation (or a transient error) — fall back below
    }
  }
  if (!minted) minted = await mintInstallationToken(creds, fetchImpl);
  await audit(store, accountId, {
    action: "token_minted",
    detail: `mint-on-demand mode=${identity.mode}${opts?.repo ? ` repo=${opts.repo}` : ""}${scoped ? " scoped" : ""}`,
  });
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
  store: EphemeralProvisioningPort,
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
export async function settleManagedMachineUsage(
  store: Pick<EphemeralProvisioningPort, "upsertSessionUsage">,
  accountId: string,
  machine: Record<string, unknown>,
  settledAt = new Date().toISOString(),
): Promise<boolean> {
  if (normalizeComputeSource(machine.computeSource) !== "managed") return false;
  const usage = usageFromManagedMachine(accountId, machine, settledAt);
  if (!usage) return false;
  await store.upsertSessionUsage(usage);
  return true;
}

export async function reapSettledHostedMachine(
  store: EphemeralProvisioningPort,
  accountId: string,
  nodeId: string,
  env: ProvisionEnv,
  nowMs = Date.now(),
  destroy: DestroyFn = destroyEphemeralMachine,
  observe: ObserveFn = observeProviderMachine,
): Promise<boolean> {
  const machines = await store.getHostedMachines(accountId);
  const record = machines.find((m) => m.nodeId === nodeId);
  if (!record) return false;
  const machine = record as unknown as EphemeralMachine;
  const hosted = await store.getHostedProvisioning(accountId);
  // Teardown resolves its credential by the machine's compute source — the CP
  // holds the operator token, so managed machines get the same full
  // server-side destroy authority as hosted ones. Never gated by the
  // MANAGED_COMPUTE_ENABLED launch switch.
  const sourceAttempt = machine.attemptId ? await store.getHostedMachineAttempt(accountId, machine.attemptId).catch(() => undefined) : undefined;
  const sourceConfigs = typeof store.getEphemeralConfigs === "function"
    ? await store.getEphemeralConfigs(accountId).catch(() => [] as EphemeralNodeConfig[])
    : [];
  const computeSource = machineComputeSource(record, sourceAttempt, sourceConfigs);
  const providerToken = (await resolveProviderCredential(hosted, machine.provider, computeSource)).token;
  // Settlement is independent of provider deletion success. A failed teardown
  // still consumed compute and remains idempotently metered on every retry.
  await settleManagedMachineUsage(store, accountId, { ...record, computeSource }, new Date(nowMs).toISOString()).catch(async () => {
    await audit(store, accountId, { action: "reconcile_failed", provider: machine.provider, nodeId, detail: "usage settlement persistence failed" });
  });
  try {
    if (providerToken) {
      if (machine.attemptId) {
        const attempt = await store.getHostedMachineAttempt(accountId, machine.attemptId).catch(() => undefined);
        // Record intent before the provider call: even if this process crashes
        // mid-destroy, `desiredState: "deleted"` survives and the next
        // reconciler tick keeps driving toward deletion instead of retrying
        // creation or leaving the attempt stuck in whatever phase it was in.
        if (attempt) await store.putHostedMachineAttempt({ ...attempt, state: "deleting", desiredState: "deleted", deadlineAt: undefined, updatedAt: new Date(nowMs).toISOString() }).catch(() => {});
      }
      await destroyOneHostedMachine(store, accountId, machine, providerToken, env, nowMs, destroy);
      // Confirmed-deletion finalizer: `destroy()` returning without throwing
      // only means the provider ACCEPTED the delete, not that the resource is
      // gone (AWS TerminateInstances is asynchronous — the instance can still
      // report "shutting-down" for a while). Re-observe before declaring the
      // attempt terminal; if the provider still sees it, leave state
      // "deleting" so the next reconcile tick (which also observes) re-checks
      // rather than trusting the delete call on its own.
      if (machine.attemptId) {
        const attempt = await store.getHostedMachineAttempt(accountId, machine.attemptId).catch(() => undefined);
        let confirmed: boolean;
        try {
          confirmed = providerToken ? (await observe(machine, providerToken)) === "gone" : false;
        } catch {
          confirmed = false;
        }
        if (attempt) {
          await store.putHostedMachineAttempt({
            ...attempt,
            state: confirmed ? "deleted" : "deleting",
            desiredState: "deleted",
            machine: machine as unknown as Record<string, unknown>,
            updatedAt: new Date(nowMs).toISOString(),
          }).catch(() => {});
        }
        if (!confirmed) {
          await audit(store, accountId, { action: "reconcile_failed", provider: machine.provider, nodeId, detail: "settled — delete accepted, not yet confirmed gone" });
          return true;
        }
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
export interface ManagedSettlementEvent {
  attemptId: string;
  at: string;
  machineSeconds: number;
  activeAgentSeconds: number;
}
export type ManagedSettlementReporter = (accountId: string, event: ManagedSettlementEvent) => Promise<void>;

export async function reconcileHostedMachines(
  store: EphemeralProvisioningPort,
  accountId: string,
  nowMs = Date.now(),
  env?: ProvisionEnv,
  destroy: DestroyFn = destroyEphemeralMachine,
  observe: ObserveFn = observeProviderMachine,
  reportManagedSettlement?: ManagedSettlementReporter,
): Promise<number> {
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
    machines.push({ ...attempt.machine, attemptId: attempt.attemptId, nodeId: attempt.nodeId, setupId: attempt.configId, purpose: attempt.desired.purpose });
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
      if (attempt.machine || attempt.desiredState === "deleted" || !["requested", "enrolled", "failed"].includes(attempt.state)) continue;
      // Enrollment rollback: a node enrolled by `requested`/`enrolled` but
      // never reaching the provider is a real, if rare, orphan risk (a plan's
      // node-limit is finite). Past a retry ceiling, stop retrying creation —
      // no provider resource was ever accepted for this attempt, so there is
      // nothing to discover/delete — and give the node back instead of
      // retrying forever.
      if (attempt.retryCount >= MAX_ATTEMPT_RETRIES) {
        await store.removeNode(accountId, attempt.nodeId).catch(() => {});
        await store.putHostedMachineAttempt({
          ...attempt,
          state: "failed",
          desiredState: "deleted",
          deadlineAt: undefined,
          lastError: `abandoned after ${attempt.retryCount} retries — node unenrolled`,
          updatedAt: new Date(nowMs).toISOString(),
        }).catch(() => {});
        await audit(store, accountId, { action: "attempt_abandoned", provider: attempt.provider, configId: attempt.configId, nodeId: attempt.nodeId, detail: `retryCount=${attempt.retryCount}` });
        continue;
      }
      const age = nowMs - Date.parse(attempt.updatedAt);
      const backoff = Math.min(15 * 60_000, 30_000 * 2 ** Math.min(attempt.retryCount, 5));
      if (!Number.isFinite(age) || age < backoff) continue;
      // A creation retry that never reached the provider is a NEW managed
      // launch: while the managed kill switch is off, hold it untouched (it
      // resumes when the switch returns). Placed after the abandonment check
      // above so hopeless attempts are still cleaned up, and everything
      // deletion-side below is untouched — cleanup never turns off.
      if (normalizeComputeSource(attempt.desired?.computeSource) === "managed" && !managedComputeEnabled()) continue;
      const config = configs.find((c) => c.id === attempt.configId) ?? {
        id: attempt.configId || `recovered-${attempt.attemptId}`,
        name: "Recovered ephemeral runner",
        provider: attempt.provider,
        region: typeof attempt.desired.region === "string" ? attempt.desired.region : undefined,
        size: typeof attempt.desired.size === "string" ? attempt.desired.size : undefined,
        image: typeof attempt.desired.image === "string" ? attempt.desired.image : undefined,
        ttlMinutes: typeof attempt.desired.ttlMinutes === "number" ? attempt.desired.ttlMinutes : 60,
        ...(normalizeComputeSource(attempt.desired.computeSource) === "managed" ? { computeSource: "managed" as const } : {}),
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt,
      };
      const retryCount = attempt.retryCount + 1;
      await store.putHostedMachineAttempt({ ...attempt, state: "requested", retryCount, lastError: undefined, updatedAt: new Date(nowMs).toISOString() });
      const restoreSessionId = typeof attempt.desired.restoreSessionId === "string" ? attempt.desired.restoreSessionId : "";
      if (restoreSessionId) {
        await provisionEphemeralRestore(store, accountId, config, env, { reuseNodeId: attempt.nodeId, restoreSessionId, attemptId: attempt.attemptId, retryCount }, launchEphemeralMachine, nowMs).catch(() => {});
      } else {
        await provisionEphemeralForAccount(store, accountId, config, env, launchEphemeralMachine, nowMs, (attempt.desired.purpose as EphemeralMachine["purpose"]) || "queue-default", { attemptId: attempt.attemptId, nodeId: attempt.nodeId, retryCount }).catch(() => {});
      }
    }
    machines = await store.getHostedMachines(accountId);
  }

  if (!machines.length && !attempts.length) return 0;
  const hosted = env ? await store.getHostedProvisioning(accountId) : null;
  // For per-machine credential-lane resolution below (managed machines tear
  // down with the operator token, regardless of the managed launch switch).
  const accountConfigs = env && typeof store.getEphemeralConfigs === "function"
    ? await store.getEphemeralConfigs(accountId).catch(() => [] as EphemeralNodeConfig[])
    : [];
  // Looked up per machine to decide whether a force-destroy (desiredState
  // "deleted" — a PWA teardown, or an attempt abandoned above) should skip
  // the "still within TTL grace" retention below and be retried immediately
  // instead of waiting out the rest of its TTL.
  const attemptById = new Map(attempts.map((a) => [a.attemptId, a]));
  const kept: Array<Record<string, unknown>> = [];
  let reaped = 0;
  let inventoryChanged = adopted;
  for (const original of machines) {
    let m = original;
    const createdAt = typeof m.createdAt === "string" ? Date.parse(m.createdAt) : NaN;
    const ttlMin = typeof m.ttlMinutes === "number" ? m.ttlMinutes : 60;
    const nodeId = typeof m.nodeId === "string" ? m.nodeId : "";
    const provider = typeof m.provider === "string" ? m.provider : "";
    const computeSource = machineComputeSource(m, typeof m.attemptId === "string" ? attemptById.get(m.attemptId) : undefined, accountConfigs);
    const providerToken = env && provider && hosted ? (await resolveProviderCredential(hosted, provider, computeSource)).token : undefined;
    const forceDelete = typeof m.attemptId === "string" && attemptById.get(m.attemptId)?.desiredState === "deleted";

    // Attempts opt into active observation. Legacy rows remain TTL-reconciled so
    // upgrades do not suddenly fan out provider calls for old inventory.
    if (env && providerToken && typeof m.attemptId === "string") {
      try {
        const observed = await observe(m as unknown as EphemeralMachine, providerToken);
        if (observed === "gone") {
          const settledAt = new Date(nowMs).toISOString();
          const meteredMachine = { ...m, computeSource };
          await settleManagedMachineUsage(store, accountId, meteredMachine, settledAt).catch(async () => {
            await audit(store, accountId, { action: "reconcile_failed", provider, nodeId: nodeId || undefined, detail: "usage settlement persistence failed" });
          });
          const usage = usageFromManagedMachine(accountId, meteredMachine, settledAt);
          const attemptId = typeof m.attemptId === "string" ? m.attemptId : "";
          if (usage && attemptId && reportManagedSettlement) {
            await reportManagedSettlement(accountId, {
              attemptId, at: settledAt, machineSeconds: usage.machineSeconds, activeAgentSeconds: usage.activeAgentSeconds,
            }).catch(async () => {
              await audit(store, accountId, { action: "reconcile_failed", provider, nodeId: nodeId || undefined, detail: "managed settlement event failed" });
            });
          }
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
    const nodeReady = typeof (m.milestones as Record<string, unknown> | undefined)?.nodeReadyAt === "string";
    const bootTimedOut = typeof m.attemptId === "string" && Number.isFinite(createdAt) && !nodeReady && nowMs - createdAt > BOOT_DEADLINE_MS;
    if (!forceDelete && Number.isFinite(createdAt) && nowMs - createdAt <= ttlGraceMs && !bootTimedOut) {
      kept.push(m);
      continue;
    }
    if (env && providerToken) {
      const deletingAttemptId = typeof m.attemptId === "string" ? m.attemptId : "";
      if (deletingAttemptId) {
        const attempt = await store.getHostedMachineAttempt(accountId, deletingAttemptId).catch(() => undefined);
        if (attempt) {
          try {
            // Fenced: if a second reconciler pass (another replica, or this
            // account's fast convergence and orphan-discovery sweeps
            // overlapping) already claimed this attempt since we read it,
            // don't also race it into `destroy()` — retain the record for
            // this pass and let whichever writer won keep driving it.
            await store.putHostedMachineAttempt(
              { ...attempt, state: "deleting", desiredState: "deleted", deadlineAt: undefined, updatedAt: new Date(nowMs).toISOString() },
              { expectedVersion: attempt.version },
            );
          } catch (error) {
            if (error instanceof ConcurrentAttemptUpdateError) {
              kept.push(m);
              continue;
            }
            // A non-fencing failure (store hiccup): best effort, still try
            // the destroy below rather than doing nothing this pass.
          }
        }
      }
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
      // Confirmed-deletion finalizer, gated the same way the pre-destroy
      // observe above is: only attempt-tracked rows opt into the extra
      // provider call, so an upgrade doesn't suddenly fan out requests for
      // untouched legacy inventory. `destroy()` not throwing only means the
      // provider ACCEPTED the delete (EC2 termination is asynchronous); don't
      // drop the resource from inventory or finalize the attempt until a
      // fresh observe agrees it's actually gone.
      if (deletingAttemptId) {
        let confirmed: boolean;
        try {
          confirmed = (await observe(m as unknown as EphemeralMachine, providerToken)) === "gone";
        } catch {
          confirmed = false;
        }
        if (!confirmed) {
          kept.push(m);
          const attempt = await store.getHostedMachineAttempt(accountId, deletingAttemptId).catch(() => undefined);
          if (attempt) await store.putHostedMachineAttempt({ ...attempt, machine: m, updatedAt: new Date(nowMs).toISOString() }).catch(() => {});
          await audit(store, accountId, {
            action: "reconcile_failed",
            provider: provider || undefined,
            nodeId: nodeId || undefined,
            detail: `${bootTimedOut ? "boot deadline exceeded" : `ttl ${ttlMin}m elapsed`} — delete accepted, not yet confirmed gone`,
          });
          continue;
        }
      }
      if (nodeId) await store.removeNode(accountId, nodeId).catch(() => {});
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
    const settledAt = new Date(nowMs).toISOString();
    const meteredMachine = { ...m, computeSource };
    await settleManagedMachineUsage(store, accountId, meteredMachine, settledAt).catch(async () => {
      await audit(store, accountId, { action: "reconcile_failed", provider: provider || undefined, nodeId: nodeId || undefined, detail: "usage settlement persistence failed" });
    });
    const usage = usageFromManagedMachine(accountId, meteredMachine, settledAt);
    const attemptId = typeof m.attemptId === "string" ? m.attemptId : "";
    if (usage && attemptId && reportManagedSettlement) {
      await reportManagedSettlement(accountId, {
        attemptId, at: settledAt, machineSeconds: usage.machineSeconds, activeAgentSeconds: usage.activeAgentSeconds,
      }).catch(async () => {
        await audit(store, accountId, { action: "reconcile_failed", provider: provider || undefined, nodeId: nodeId || undefined, detail: "managed settlement event failed" });
      });
    }
    reaped++;
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
  store: EphemeralProvisioningPort,
  env: ProvisionEnv,
  nowMs = Date.now(),
  destroy: DestroyFn = destroyEphemeralMachine,
  reportManagedSettlement?: ManagedSettlementReporter,
): Promise<ReconcileAllResult> {
  const accountIds = await store.listHostedMachineAccountIds();
  const result: ReconcileAllResult = { accounts: accountIds.length, reaped: 0, failed: 0 };
  for (const accountId of accountIds) {
    try {
      result.reaped += await reconcileHostedMachines(store, accountId, nowMs, env, destroy, observeProviderMachine, reportManagedSettlement);
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

export interface OrphanSweepResult {
  found: number;
  reaped: number;
  failed: number;
}

/** Every provider resource id this account is currently tracking, across both
 * the legacy inventory array and every non-terminal attempt. The orphan sweep
 * below uses this to tell "found via discover but already known" apart from a
 * genuine orphan. */
function trackedResourceIds(machines: Array<Record<string, unknown>>, attempts: HostedMachineAttempt[]): Set<string> {
  const ids = new Set<string>();
  for (const m of machines) if (typeof m.id === "string") ids.add(m.id);
  for (const a of attempts) if (typeof a.machine?.id === "string") ids.add(String(a.machine.id));
  return ids;
}

/**
 * Discover-based orphan recovery — deletion needs discovery, not only a
 * remembered id. Every other recovery path in this file — attempt-adoption,
 * idempotent-create-and-adopt, retry —
 * depends on the durable attempt row surviving. This is the one path that
 * doesn't: it asks each provider directly for everything tagged as this
 * account's (`ProviderAdapter.discover`) and reconciles anything neither the
 * legacy inventory nor any attempt row still knows about.
 *
 * Deliberately conservative — a resource younger than the boot deadline is
 * left alone, since a create whose attempt-row write is merely slow (not
 * lost) would otherwise be raced by a spurious "orphan" delete. Only runs for
 * providers whose adapter implements `discover` (Hetzner/Fly/EC2 today).
 */
/** Ask one provider for everything tagged as this account's. Returns
 * `undefined` when an adapter has no `discover` capability, distinct from an
 * empty array (checked, nothing found). Injectable so tests
 * can exercise the sweep's cross-referencing/idempotency logic without a real
 * provider transport — mirrors `DestroyFn`/`ObserveFn` above. */
export type DiscoverFn = (provider: string, token: string, ownershipTag: string) => Promise<EphemeralMachine[] | undefined>;

const discoverProviderResources: DiscoverFn = async (provider, token, ownershipTag) => {
  const adapter = ephemeralAdapter(provider);
  if (!adapter?.discover) return undefined;
  return adapter.discover({ exec: directExec(), token, ownershipTag });
};

export async function sweepOrphanProviderResources(
  store: EphemeralProvisioningPort,
  accountId: string,
  env: ProvisionEnv,
  nowMs = Date.now(),
  destroy: DestroyFn = destroyEphemeralMachine,
  observe: ObserveFn = observeProviderMachine,
  discover: DiscoverFn = discoverProviderResources,
): Promise<OrphanSweepResult> {
  const result: OrphanSweepResult = { found: 0, reaped: 0, failed: 0 };
  const hosted = await store.getHostedProvisioning(accountId);
  if (!hosted.enabled) return result;
  const [machines, attempts] = await Promise.all([
    store.getHostedMachines(accountId),
    store.listHostedMachineAttempts ? store.listHostedMachineAttempts(accountId, true).catch(() => []) : Promise.resolve([] as HostedMachineAttempt[]),
  ]);
  const tracked = trackedResourceIds(machines, attempts);
  const ownershipTag = ownershipTagFor(accountId);
  // One scan lane per (provider, credential): every validated user token, plus
  // the operator token for any provider this account has a managed config or
  // attempt on — a managed orphan lives in the OPERATOR's provider account and
  // is invisible to user credentials. Runs regardless of the managed launch
  // kill switch (cleanup never turns off).
  const lanes: Array<{ provider: string; token: string }> = Object.entries(hosted.providerTokens ?? {})
    .filter(([provider, token]) => hosted.validatedProviders?.[provider] === providerCredentialFingerprint(token))
    .map(([provider, token]) => ({ provider, token }));
  const managedProviders = new Set<string>();
  for (const config of await store.getEphemeralConfigs(accountId).catch(() => [] as EphemeralNodeConfig[])) {
    if (normalizeComputeSource(config.computeSource) === "managed") managedProviders.add(config.provider);
  }
  for (const attempt of attempts) {
    if (normalizeComputeSource(attempt.desired?.computeSource) === "managed") managedProviders.add(attempt.provider);
  }
  for (const provider of managedProviders) {
    const token = await operatorTokenSource().getToken(provider);
    if (token) lanes.push({ provider, token });
  }
  for (const { provider, token } of lanes) {
    let discovered: EphemeralMachine[] | undefined;
    try {
      discovered = await discover(provider, token, ownershipTag);
    } catch (error) {
      result.failed++;
      await audit(store, accountId, { action: "reconcile_failed", provider, detail: `orphan discover: ${String((error as Error)?.message || error).slice(0, 120)}` });
      continue;
    }
    if (!discovered) continue;
    for (const orphan of discovered) {
      if (tracked.has(orphan.id)) continue;
      const createdAtMs = Date.parse(orphan.createdAt || "");
      if (Number.isFinite(createdAtMs) && nowMs - createdAtMs < BOOT_DEADLINE_MS) continue;
      result.found++;
      // Idempotent key: the resource's own provider id when its bivy-attempt
      // tag is unreadable, so re-running the sweep updates the same row
      // instead of piling up duplicates for a resource still being retried.
      const attemptId = orphan.attemptId || `orphan-${provider}-${orphan.id}`;
      const existing = await store.getHostedMachineAttempt(accountId, attemptId).catch(() => undefined);
      await store.putHostedMachineAttempt({
        accountId, attemptId, provider,
        nodeId: existing?.nodeId ?? orphan.nodeId ?? "",
        state: "deleting", desiredState: "deleted", ownershipTag,
        desired: existing?.desired ?? {},
        machine: orphan as unknown as Record<string, unknown>,
        lastError: undefined, retryCount: existing?.retryCount ?? 0,
        createdAt: existing?.createdAt ?? (orphan.createdAt || new Date(nowMs).toISOString()),
        updatedAt: new Date(nowMs).toISOString(),
      }).catch(() => {});
      await audit(store, accountId, { action: "orphan_detected", provider, nodeId: orphan.nodeId, detail: `resource ${orphan.id} untracked by inventory or any attempt` });
      try {
        await destroyOneHostedMachine(store, accountId, orphan, token, env, nowMs, destroy);
        let confirmed: boolean;
        try {
          confirmed = (await observe(orphan, token)) === "gone";
        } catch {
          confirmed = false;
        }
        const latest = await store.getHostedMachineAttempt(accountId, attemptId).catch(() => undefined);
        if (latest) await store.putHostedMachineAttempt({ ...latest, state: confirmed ? "deleted" : "deleting", updatedAt: new Date(nowMs).toISOString() }).catch(() => {});
        if (confirmed) {
          result.reaped++;
          await audit(store, accountId, { action: "orphan_reaped", provider, nodeId: orphan.nodeId, detail: `resource ${orphan.id}` });
        } else {
          result.failed++;
          await audit(store, accountId, { action: "reconcile_failed", provider, nodeId: orphan.nodeId, detail: `orphan ${orphan.id} — delete accepted, not yet confirmed gone` });
        }
      } catch (error) {
        result.failed++;
        await audit(store, accountId, { action: "reconcile_failed", provider, nodeId: orphan.nodeId, detail: `orphan destroy: ${String((error as Error)?.message || error).slice(0, 120)}` });
      }
    }
  }
  return result;
}

export interface OrphanSweepAllResult extends OrphanSweepResult {
  accounts: number;
}

/** Sweep every account with hosted provisioning enabled — a superset of the
 * accounts `reconcileAllHostedMachines` visits, since the whole point of this
 * sweep is to catch the case where tracking itself (both the legacy array AND
 * every attempt row) was lost. Runs on its own, coarser interval than the
 * fast convergence sweep: `discover` is a heavier, multi-call provider
 * operation and has no business running every tick (see index.ts wiring). */
export async function sweepAllOrphanProviderResources(store: EphemeralProvisioningPort, env: ProvisionEnv, nowMs = Date.now()): Promise<OrphanSweepAllResult> {
  const accountIds = await store.listHostedEnabledAccountIds();
  const result: OrphanSweepAllResult = { accounts: accountIds.length, found: 0, reaped: 0, failed: 0 };
  for (const accountId of accountIds) {
    try {
      const r = await sweepOrphanProviderResources(store, accountId, env, nowMs);
      result.found += r.found;
      result.reaped += r.reaped;
      result.failed += r.failed;
    } catch (error) {
      result.failed++;
      await audit(store, accountId, { action: "reconcile_failed", detail: `orphan sweep: ${String((error as Error)?.message || error).slice(0, 160)}` });
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
  store: EphemeralProvisioningPort,
  accountId: string,
  env: ProvisionEnv,
  launcher = launchEphemeralMachine,
  admitManaged: ManagedProvisionAdmission = allowManagedProvision,
  onManagedLaunchFailed: (attemptId: string) => Promise<void> = async () => {},
  reportManagedSettlement?: ManagedSettlementReporter,
): Promise<EphemeralMachine | null> {
  const leaseHolder = randomUUID();
  let replenish = false;
  let admittedManagedAttemptId: string | undefined;
  let heartbeat: { stop: () => void; isLost: () => boolean } | undefined;
  try {
    // Lazy lifecycle reconciliation: prune (and actively destroy leak-prone)
    // machines past TTL before deciding, so dedupe/rate-cap see fresh state and
    // node slots are freed. Passing env lets it DELETE the provider resource
    // (Hetzner) rather than only forgetting the record.
    await reconcileHostedMachines(
      store, accountId, Date.now(), env, destroyEphemeralMachine, observeProviderMachine, reportManagedSettlement,
    ).catch(() => {});
    // Planning and launching must be one cross-replica critical section. Without
    // this lease, two webhook/control-plane workers can both observe no active
    // machine and each create a separately billed VM. Five minutes covers slow
    // compatibility boot APIs; expiry recovers automatically after a crash.
    if (!(await store.acquireHostedProvisionLease(accountId, leaseHolder, PROVISION_LEASE_SECONDS))) return null;
    heartbeat = startLeaseHeartbeat(store, accountId, leaseHolder);
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
        // Fence the claim: if our lease was already declared lost (renewal
        // failed — a stalled DB, a long GC pause), a second replica may have
        // since acquired it and be mid-claim itself. Refuse to commit a
        // claim/route write neither replica can be sure is exclusive, rather
        // than risk routing the same pending work twice.
        if (heartbeat.isLost()) {
          console.error(`[hosted-provision] lease lost before capacity claim — skipping account=${accountId}`);
          return null;
        }
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
    const managedAttemptId = randomUUID();
    const plan = await planAutoProvision(store, accountId, Date.now(), admitManaged, managedAttemptId);
    if (!plan.willProvision || !plan.targetConfigId) return null;
    const plannedTarget = configs.find((c) => c.id === plan.targetConfigId);
    if (!plannedTarget) return null;
    if (normalizeComputeSource(plannedTarget.computeSource) === "managed") admittedManagedAttemptId = managedAttemptId;
    // Case B + Gap 3: if a pending item wants to CONTINUE an existing session whose
    // (torn-down) node still has an escrowed room key, rebuild that session in place
    // server-side rather than launching a blank machine. Best-effort — any gap
    // (no correlation / no escrowed key) falls back to a normal fresh provision.
    const restore = await planRestoreProvision(store, accountId).catch(() => null);
    const machine = restore
      ? await provisionEphemeralRestore(store, accountId, plannedTarget, env, { ...restore, attemptId: managedAttemptId }, launcher)
      : await provisionEphemeralForAccount(store, accountId, plannedTarget, env, launcher, Date.now(), "queue-default", {
          attemptId: managedAttemptId, retryCount: 0,
        });
    // A hosted runner serves its unique `bivy/<eph suffix>` label. Move only
    // work that was waiting on the routing target which caused this launch;
    // explicit items for another node/config must remain untouched.
    await routePendingWorkToMachine(store, accountId, plannedTarget, machine);
    return machine;
  } catch (e) {
    if (admittedManagedAttemptId) await onManagedLaunchFailed(admittedManagedAttemptId).catch(() => {});
    console.error(`[hosted-provision] account ${accountId}:`, (e as Error)?.message || e);
    return null;
  } finally {
    heartbeat?.stop();
    await store.releaseHostedProvisionLease(accountId, leaseHolder).catch(() => {});
    if (replenish) void ensureReadyCapacity(store, accountId, env, launcher).catch(() => {});
  }
}
