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

const TERMINAL = new Set(["destroyed", "deleted", "failed", "stopped"]);

export function activeManagedMachineCount(machines: readonly ManagedAdmissionMachine[], nowMs = Date.now()): number {
  return machines.filter((machine) => {
    if (machine.computeSource !== "managed" || TERMINAL.has(String(machine.status || "").toLowerCase())) return false;
    const created = Date.parse(String(machine.createdAt || ""));
    const ttlMs = Math.max(5, Number(machine.ttlMinutes) || 60) * 60_000;
    return !Number.isFinite(created) || created + ttlMs > nowMs;
  }).length;
}

export function managedConcurrencyLimit(raw = process.env.MANAGED_COMPUTE_MAX_ACTIVE_PER_ACCOUNT): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
