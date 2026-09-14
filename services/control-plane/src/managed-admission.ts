// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** Minimum non-secret Machine facts needed for the control plane's last-resort
 * managed concurrency ceiling. Deployment policy still owns plans and spend. */
export interface ManagedAdmissionMachine {
  computeSource?: "user" | "managed";
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

export function managedConcurrencyLimit(raw = process.env.MANAGED_COMPUTE_MAX_ACTIVE_PER_ACCOUNT): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
