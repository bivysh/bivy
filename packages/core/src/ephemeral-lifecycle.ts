// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Pure ephemeral-compute values and projections. This module deliberately has
// no browser, transport, storage, provider, or clock dependencies: callers
// supply facts (including `nowMs`) and receive derived data.

export interface PricedMachineSize {
  pricePerHour?: number;
}

export interface EphemeralLifecycleMilestones {
  requestedAt?: string;
  providerAcceptedAt?: string;
  nodeReadyAt?: string;
  credentialsReadyAt?: string;
  snapshotReadyAt?: string;
  firstAgentEventAt?: string;
}

export interface EphemeralLifecycleFacts {
  milestones?: EphemeralLifecycleMilestones;
  purpose?: "queue-item" | "queue-default" | "ready-capacity";
  claimedAt?: string;
}

export type EphemeralLifecyclePhase =
  | "provisioning"
  | "node-ready"
  | "hydrating"
  | "ready"
  | "claimed"
  | "working"
  | "teardown-failed";

/** Clamp a requested TTL into a sane 5-minute…24-hour window (default 60). */
export function clampTtlMinutes(ttlMinutes?: number): number {
  return Math.max(5, Math.min(24 * 60, Number(ttlMinutes) || 60));
}

/** User-facing lifecycle derived only from durable, server-stamped facts. */
export function ephemeralLifecyclePhase(
  facts: EphemeralLifecycleFacts,
  teardownFailed = false,
): EphemeralLifecyclePhase {
  if (teardownFailed) return "teardown-failed";
  if (facts.milestones?.firstAgentEventAt) return "working";
  if (facts.claimedAt || facts.purpose === "queue-default" || facts.purpose === "queue-item") return "claimed";
  if (facts.purpose === "ready-capacity" && facts.milestones?.credentialsReadyAt) return "ready";
  if (facts.milestones?.nodeReadyAt && !facts.milestones?.credentialsReadyAt) return "hydrating";
  if (facts.milestones?.nodeReadyAt) return "node-ready";
  return "provisioning";
}

export function ephemeralColdStartMs(facts: Pick<EphemeralLifecycleFacts, "milestones">): number | undefined {
  const start = Date.parse(String(facts.milestones?.requestedAt || ""));
  const ready = Date.parse(String(facts.milestones?.firstAgentEventAt || ""));
  return Number.isFinite(start) && Number.isFinite(ready) && ready >= start ? ready - start : undefined;
}

/** Currency symbol for indicative cost estimates, not invoices. */
function currencySymbol(currency: string): string {
  return currency === "EUR" ? "€" : "$";
}

export function formatEphemeralPrice(amount: number, currency = "USD"): string {
  const sym = currencySymbol(currency);
  const digits = amount < 0.1 ? 4 : 2;
  return `${sym}${amount.toFixed(digits)}`;
}

export function ephemeralCostHint(
  size: PricedMachineSize | undefined,
  ttlMinutes: number | undefined,
  currency = "USD",
): string {
  const rate = size?.pricePerHour;
  if (!rate || rate <= 0) return "";
  const perHour = `≈ ${formatEphemeralPrice(rate, currency)}/hr`;
  if (!ttlMinutes || ttlMinutes <= 0) return perHour;
  const hours = clampTtlMinutes(ttlMinutes) / 60;
  return `${perHour} · up to ${formatEphemeralPrice(rate * hours, currency)} before it self-destructs`;
}

/** Derive cost from supplied facts. `nowMs` is explicit to keep the function deterministic. */
export function ephemeralCostEstimate(
  size: PricedMachineSize | undefined,
  createdAt: string,
  ttlMinutes: number | undefined,
  nowMs: number,
): { accrued: number; maximum: number } | null {
  const rate = size?.pricePerHour;
  const start = Date.parse(createdAt);
  if (!rate || rate <= 0 || !Number.isFinite(start)) return null;
  const ttl = clampTtlMinutes(ttlMinutes);
  const elapsedHours = Math.max(0, Math.min(nowMs - start, ttl * 60_000)) / 3_600_000;
  return { accrued: rate * elapsedHours, maximum: rate * ttl / 60 };
}
