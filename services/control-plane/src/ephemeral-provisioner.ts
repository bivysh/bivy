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
import {
  launchEphemeralMachine,
  destroyEphemeralMachine,
  validateEphemeralProviderToken,
  type ExecFn,
  type ExecRequest,
  type LocalStore,
  type EphemeralMachine,
  type EphemeralKeyStore,
  type MachineStore,
} from "@bivy/core";
import { providerCredentialFingerprint, type MeshStore, type EphemeralNodeConfig, type QueueRouting, type HostedAuditEvent } from "./store.js";
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
    const startMs = Date.parse(String(requestedAt || ""));
    const atMs = Date.parse(at);
    const elapsed = Number.isFinite(startMs) && Number.isFinite(atMs) && atMs >= startMs ? ` elapsedMs=${atMs - startMs}` : "";
    await audit(store, accountId, { action: "machine_milestone", nodeId, detail: `${milestone}${elapsed}` });
  }
  return found;
}

const DEDUPE_WINDOW_MS = 60 * 60 * 1000; // don't stack hosted machines within an hour
const MAX_PROVISIONS_PER_HOUR = Math.max(1, Number(process.env.HOSTED_PROVISION_MAX_PER_HOUR ?? 5));

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
  // Fail-closed deployment gate: ephemeral machines are off unless the deploy set
  // EPHEMERAL_MACHINES_ENABLED=1 (production leaves it off). This is the single
  // choke point for ALL server-initiated auto-launches — both maybeAutoProvision
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
  try {
    const machine = await launcher(
      {
        provider: config.provider,
        region: config.region,
        size: config.size,
        ttlMinutes: config.ttlMinutes,
        hostedTasks: true,
        githubToken,
        hostedMint: useHostedMint,
        setupId: config.id,
        purpose: "queue-default",
        name: `Hosted ${config.name}`,
      },
      { store: localStore, exec: directExec(), keys: serverKeyStore(providerToken), machines: serverMachineStore(store, accountId, nowMs) },
    );
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
    await audit(store, accountId, { action: "provision_failed", provider: config.provider, configId: config.id, detail: String((e as Error)?.message || e).slice(0, 200) });
    throw e;
  }
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
        ttlMinutes: config.ttlMinutes,
        hostedTasks: true,
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
      await audit(store, accountId, { action: "machine_reaped", provider: machine.provider, nodeId, detail: "settled — destroyed" });
    } else {
      // No hosted token to authenticate a destroy (unexpected for hosted): at
      // least forget the record + unenroll so the node slot frees.
      await store.setHostedMachines(accountId, machines.filter((m) => m.nodeId !== nodeId));
      await store.removeNode(accountId, nodeId).catch(() => {});
      await audit(store, accountId, { action: "machine_reaped", nodeId, detail: "settled — no token" });
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
export async function reconcileHostedMachines(store: MeshStore, accountId: string, nowMs = Date.now(), env?: ProvisionEnv, destroy: DestroyFn = destroyEphemeralMachine): Promise<number> {
  const machines = await store.getHostedMachines(accountId);
  if (!machines.length) return 0;
  const hosted = env ? await store.getHostedProvisioning(accountId) : null;
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
    const nodeId = typeof m.nodeId === "string" ? m.nodeId : "";
    const provider = typeof m.provider === "string" ? m.provider : "";
    const providerToken = env && provider ? hosted?.providerTokens?.[provider] : undefined;
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
    await audit(store, accountId, { action: "machine_reaped", nodeId: nodeId || undefined, detail: `ttl ${ttlMin}m elapsed${env && providerToken ? " — destroyed" : ""}` });
  }
  if (reaped) await store.setHostedMachines(accountId, kept);
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
  try {
    // Lazy lifecycle reconciliation: prune (and actively destroy leak-prone)
    // machines past TTL before deciding, so dedupe/rate-cap see fresh state and
    // node slots are freed. Passing env lets it DELETE the provider resource
    // (Hetzner) rather than only forgetting the record.
    await reconcileHostedMachines(store, accountId, Date.now(), env).catch(() => {});
    const plan = await planAutoProvision(store, accountId);
    if (!plan.willProvision || !plan.targetConfigId) return null;
    const configs = await store.getEphemeralConfigs(accountId);
    const target = configs.find((c) => c.id === plan.targetConfigId);
    if (!target) return null;
    // Case B + Gap 3: if a pending item wants to CONTINUE an existing session whose
    // (torn-down) node still has an escrowed room key, rebuild that session in place
    // server-side rather than launching a blank machine. Best-effort — any gap
    // (no correlation / no escrowed key) falls back to a normal fresh provision.
    const restore = await planRestoreProvision(store, accountId).catch(() => null);
    if (restore) return await provisionEphemeralRestore(store, accountId, target, env, restore, launcher);
    return await provisionEphemeralForAccount(store, accountId, target, env, launcher);
  } catch (e) {
    console.error(`[hosted-provision] account ${accountId}:`, (e as Error)?.message || e);
    return null;
  }
}
