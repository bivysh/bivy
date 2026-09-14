// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** Minimum non-secret Machine facts needed for the control plane's last-resort
 * managed concurrency ceiling. Deployment policy still owns plans and spend. */
export interface ManagedAdmissionMachine {
  computeSource?: "user" | "managed";
  id?: unknown;
  attemptId?: unknown;
  status?: string;
  createdAt?: string;
  ttlMinutes?: number;
}

const TERMINAL = new Set(["destroyed", "deleted", "gone"]);

export function activeManagedMachineCount(machines: readonly ManagedAdmissionMachine[], _nowMs = Date.now()): number {
  // A TTL is desired policy, not an observation. Failed/stopped resources may
  // still incur charges and consume capacity until deletion is confirmed.
  return machines.filter((machine) => machine.computeSource === "managed"
    && !TERMINAL.has(String(machine.status || "").toLowerCase())).length;
}

/** Count durable reservations as well as inventory, without counting the same
 * provider resource twice during the handoff from attempt to tracked machine. */
export function managedCapacityCount(machines: readonly ManagedAdmissionMachine[], attempts: readonly {
  attemptId: string; state: string; desired: Record<string, unknown>; machine?: Record<string, unknown>;
}[]): number {
  const active = machines.filter((m) => activeManagedMachineCount([m]) > 0);
  return active.length + attempts.filter((a) => a.state !== "deleted" && a.desired.computeSource === "managed"
    && !active.some((m) => m.attemptId === a.attemptId || (m.id && m.id === a.machine?.id))).length;
}

export function managedConcurrencyLimit(raw = process.env.MANAGED_COMPUTE_MAX_ACTIVE_PER_ACCOUNT): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
