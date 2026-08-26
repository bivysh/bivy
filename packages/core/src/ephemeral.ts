// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Compatibility facade and ephemeral launch orchestration. Pure facts, local
// persistence, and provider effects live behind explicit module boundaries.

import { b64, b64url, unb64url } from "./base64.js";
import type { LocalStore } from "./local-store.js";
import {
  buildBootstrapUserData,
  ephemeralAdapter,
  type ExecFn,
  type ProviderSize,
} from "./ephemeral-provider-adapters.js";
import type { EphemeralMachine } from "./ephemeral-machine.js";
import { planEphemeralLaunch, trackProvisionedMachine } from "./ephemeral-launch-plan.js";
import { createEphemeralExecutionEnvelope } from "./ephemeral-execution-envelope.js";
import type { EphemeralKeyStore, MachineStore } from "./ephemeral-storage.js";

export {
  EPHEMERAL_PROVIDERS,
  ephemeralCatalogEntry,
  type EphemeralProviderCatalog,
} from "./ephemeral-catalog.js";
export {
  EPHEMERAL_COMPUTE_INTENT_LABELS,
  ephemeralComputeIntent,
  ephemeralComputeIntentLabel,
  type EphemeralComputeIntent,
} from "./ephemeral-compute.js";
export {
  clampTtlMinutes,
  ephemeralColdStartMs,
  ephemeralCostHint,
  ephemeralLifecyclePhase,
  formatEphemeralPrice,
  type EphemeralLifecycleFacts,
  type EphemeralLifecycleMilestones,
  type EphemeralLifecyclePhase,
  type PricedMachineSize,
} from "./ephemeral-lifecycle.js";
export {
  ephemeralMachineFromCorrelation,
  ephemeralMachineFromNode,
  isEphemeralNode,
  type EphemeralMachine,
  type EphemeralMachinePurpose,
  type EphemeralMilestones,
  type SessionCorrelation,
} from "./ephemeral-machine.js";
export {
  ephemeralNodeLabel,
  planEphemeralLaunch,
  trackProvisionedMachine,
  type EphemeralLaunchPlan,
  type EphemeralLaunchPlanInput,
} from "./ephemeral-launch-plan.js";
export {
  createEphemeralExecutionEnvelope,
  type EphemeralExecutionEnvelope,
  type EphemeralExecutionEnvelopeInput,
} from "./ephemeral-execution-envelope.js";
export {
  createEphemeralKeyStore,
  createEphemeralModelKeyStore,
  createDeviceOAuthCredentialStore,
  createEphemeralPrefsStore,
  createEphemeralSetupStore,
  createGithubTaskTokenStore,
  createMachineStore,
  createPendingEphemeralLaunchStore,
  indexedDbBackend,
  memoryBackend,
  type DeviceCredentialScope,
  type DeviceOAuthCredential,
  type DeviceOAuthCredentialStore,
  type EphemeralKeyStore,
  type EphemeralModelKeyEntry,
  type EphemeralModelKeyInfo,
  type EphemeralModelKeyStore,
  type EphemeralPrefs,
  type EphemeralPrefsStore,
  type EphemeralSetup,
  type EphemeralSetupStore,
  type GithubTaskTokenStore,
  type KvBackend,
  type MachineStore,
  type PendingEphemeralLaunch,
  type PendingEphemeralLaunchStore,
  type ProviderKeyInfo,
} from "./ephemeral-storage.js";
export {
  ALLOWED_HOSTS,
  assertAllowedUrl,
  awsSign,
  buildBootstrapUserData,
  ephemeralAdapter,
  ephemeralCostEstimate,
  extractProviderMessage,
  parseAwsToken,
  parseXml,
  validateEphemeralProviderToken,
  xmlChild,
  xmlChildren,
  xmlFind,
  type AwsCreds,
  type XmlEl,
} from "./ephemeral-provider-adapters.js";
export type {
  BootstrapOpts,
  ExecFn,
  ExecRequest,
  ExecResult,
  ProviderAccelerator,
  ProviderAdapter,
  ProviderProvisionConfig,
  ProviderSize,
} from "./ephemeral-provider-ports.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

function nowIso(): string {
  try { return new Date().toISOString(); } catch { return ""; }
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
  /** Use the separately encrypted hosted credential snapshot without implying
   * that this Machine may poll unattended task queues. */
  hostedCredentialCustody?: boolean;
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
  const { res: enrollRes, data: enroll } = await enrollOnce();
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

  const plan = planEphemeralLaunch({
    ...opts,
    attemptId,
    nodeId,
    requestedAt,
    defaultRegion: adapter.defaultRegion,
    defaultSize: adapter.defaultSize,
  });
  // The plan is safe to inspect. Secret-bearing bootstrap material is created
  // separately and consumed only by this effect interpreter.
  const envelope = createEphemeralExecutionEnvelope({
    ...opts,
    provider: plan.provider,
    nodeId: plan.nodeId,
    enrollmentToken: enroll.enrollmentToken,
    roomKeyB64: b64(roomBytes),
    relayUrl: deps.store.relay,
    controlPlaneUrl: cpBase(deps.store),
  });
  const userData = buildBootstrapUserData(envelope.bootstrap);
  progress(`Creating the machine in ${plan.region} (${plan.size})…`);
  let machine: EphemeralMachine;
  try {
    machine = await adapter.provision({
      exec: deps.exec,
      token,
      userData,
      bootstrap: envelope.bootstrap,
      config: plan.providerConfig,
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
  const accepted = { ...machine, attemptId };
  await opts.onLifecycle?.({ attemptId, nodeId, phase: "provider-accepted", machine: accepted });
  progress("Machine created. Boot setup is installing and starting Bivy…");
  machine = trackProvisionedMachine(accepted, plan, nowIso());
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
