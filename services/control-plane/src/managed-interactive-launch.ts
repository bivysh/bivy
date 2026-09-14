// SPDX-License-Identifier: AGPL-3.0-only
// One account-wide critical section for interactive/auth launches and restores.
// Durable attempts are both the request receipt and the capacity reservation.
import { createHash, randomUUID } from "node:crypto";
import type { EphemeralMachine } from "@bivy/core";
import type { EphemeralNodeConfig, HostedMachineAttempt, HostedMachineRepository } from "./store.js";
import { ownershipTagFor } from "./store.js";
import { managedCapacityCount, managedConcurrencyLimit } from "./managed-admission.js";

export class ManagedLaunchConflict extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export function managedRequestId(value: unknown): string {
  // Old clients remain compatible. Updated clients persist this ID before HTTP.
  if (value === undefined) return randomUUID();
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,200}$/.test(value)) {
    throw new ManagedLaunchConflict(400, "invalid_request_id", "requestId must be 1–200 letters, digits, dots, colons, underscores or hyphens.");
  }
  return value;
}

export interface ManagedInteractiveRequest {
  requestId: string;
  config: EphemeralNodeConfig;
  purpose: "interactive" | "auth-runner";
  runtimeId?: string;
  restore?: { nodeId: string; sessionId: string };
}

export async function managedInteractiveLaunch(
  store: HostedMachineRepository,
  accountId: string,
  request: ManagedInteractiveRequest,
  effects: {
    admit(attemptId: string): Promise<void>;
    launch(attemptId: string, nodeId: string): Promise<EphemeralMachine>;
    launchFailed?(attemptId: string): Promise<void>;
    limit?: number;
  },
): Promise<{ machine: EphemeralMachine; duplicate: boolean }> {
  const requestId = managedRequestId(request.requestId);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const attemptId = `interactive-${hash(JSON.stringify([accountId, requestId])).slice(0, 48)}`;
  const fingerprint = hash(JSON.stringify([request.purpose, request.config.id, request.runtimeId || "", request.restore?.nodeId || "", request.restore?.sessionId || ""]));
  const conflict = (code: string, message: string, status = 409): never => { throw new ManagedLaunchConflict(status, code, message); };
  const holder = randomUUID();
  const leaseSeconds = 300;
  if (!await store.acquireHostedProvisionLease(accountId, holder, leaseSeconds)) {
    return conflict("managed_launch_busy", "Another launch is in progress. Retry this same request.");
  }
  let lost = false;
  const renew = async () => {
    try { if (!await store.renewHostedProvisionLease(accountId, holder, leaseSeconds)) lost = true; }
    catch { lost = true; }
  };
  const heartbeat = setInterval(() => { void renew(); }, 30_000);
  heartbeat.unref?.();
  let admitted = false;
  try {
    const previous = await store.getHostedMachineAttempt(accountId, attemptId);
    if (previous) {
      if (previous.desired.requestFingerprint !== fingerprint) return conflict("managed_request_conflict", "This requestId was already used for a different launch.");
      if (previous.state === "deleted") return conflict("managed_request_finished", "This launch was already deleted. Start a new request to launch again.", 410);
      if (previous.desiredState === "deleted") return conflict("managed_launch_deleting", "This launch is being cleaned up; no replacement was created.");
      if (previous.machine?.id) return { machine: { ...previous.machine, nodeId: previous.nodeId, computeSource: "managed" } as unknown as EphemeralMachine, duplicate: true };
      return conflict("managed_launch_pending", "This launch is still being recovered. Retry this same request; no replacement was created.");
    }
    const [machines, attempts] = await Promise.all([store.getHostedMachines(accountId), store.listHostedMachineAttempts(accountId, true)]);
    if (request.purpose === "auth-runner") {
      const setupAttempt = attempts.find((a) => a.desired.computeSource === "managed" && a.desired.purpose === "auth-runner");
      if (setupAttempt?.desiredState === "deleted") return conflict("managed_launch_deleting", "The setup machine is being cleaned up.");
      const existing = machines.find((m) => m.computeSource === "managed" && m.purpose === "auth-runner") ?? setupAttempt?.machine;
      if (existing) return { machine: existing as unknown as EphemeralMachine, duplicate: true };
      if (setupAttempt) return conflict("managed_launch_pending", "The setup machine is still being recovered. Retry this same request.");
    }
    if (request.restore) {
      // Different tabs may issue different request IDs. Never provision two VMs
      // with the same node/enrollment identity, even if the account has capacity.
      const nodeId = request.restore.nodeId;
      if (machines.some((m) => m.nodeId === nodeId) || attempts.some((a) => a.nodeId === nodeId && a.state !== "deleted")) {
        return conflict("managed_restore_active", "This node still has an active or unresolved machine. Reconnect or finish cleanup before restoring.");
      }
    }
    const limit = effects.limit ?? managedConcurrencyLimit();
    if (limit !== undefined && managedCapacityCount(machines, attempts) >= limit) {
      return conflict("managed_concurrency_limit", "Managed machine capacity is already reserved for this account.", 429);
    }
    await effects.admit(attemptId);
    admitted = true;
    await renew();
    if (lost) return conflict("managed_launch_busy", "Launch ownership expired before provisioning. Retry this same request.");
    const nodeId = request.restore?.nodeId || `eph-${hash(attemptId).slice(0, 32)}`;
    const now = new Date().toISOString();
    const config = request.config;
    const reservation: HostedMachineAttempt = {
      accountId, attemptId, configId: config.id, provider: config.provider, nodeId,
      state: "requested", desiredState: "active", ownershipTag: ownershipTagFor(accountId),
      desired: { requestFingerprint: fingerprint, computeSource: "managed", purpose: request.purpose,
        region: config.region, size: config.size, image: config.image, ttlMinutes: config.ttlMinutes,
        teardownOnAgentFinish: config.teardownOnAgentFinish, setupId: config.id,
        ...(request.restore ? { restoreSessionId: request.restore.sessionId } : {}) },
      retryCount: 0, createdAt: now, updatedAt: now,
    };
    // Persist before any enrollment/provider effect. After a crash this continues
    // to consume capacity and reconciliation owns recovery of the same attempt.
    await store.putHostedMachineAttempt(reservation);
    const machine = await effects.launch(attemptId, nodeId);
    const current = await store.getHostedMachineAttempt(accountId, attemptId);
    if (!current) throw new Error("Launch reservation disappeared");
    await store.putHostedMachineAttempt({ ...current, machine: { ...machine, computeSource: "managed" }, updatedAt: new Date().toISOString() }, { expectedVersion: current.version });
    return { machine, duplicate: false };
  } catch (error) {
    if (admitted) await effects.launchFailed?.(attemptId).catch(() => {});
    throw error;
  } finally {
    clearInterval(heartbeat);
    await store.releaseHostedProvisionLease(accountId, holder).catch(() => {});
  }
}
