// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { SessionUsageRecord } from "./store.js";

export function utcMonthWindow(nowMs = Date.now()): { startsAt: string; endsAt: string } {
  const now = new Date(nowMs);
  const starts = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const ends = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return { startsAt: new Date(starts).toISOString(), endsAt: new Date(ends).toISOString() };
}

function validIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

/** Convert durable lifecycle facts into one provider-neutral settlement
 * estimate. Core records technical facts only; a configured deployment
 * extension owns commercial tiers, trials, caps and account presentation. */
export function usageFromManagedMachine(
  accountId: string,
  machine: Record<string, unknown>,
  settledAt: string,
): SessionUsageRecord | undefined {
  const milestones = machine.milestones && typeof machine.milestones === "object"
    ? machine.milestones as Record<string, unknown> : {};
  const launchedAt = validIso(machine.createdAt) ?? validIso(milestones.requestedAt);
  const settled = validIso(settledAt);
  if (!launchedAt || !settled || Date.parse(settled) < Date.parse(launchedAt)) return undefined;
  const firstAgentEventAt = validIso(milestones.firstAgentEventAt);
  const boundedFirst = firstAgentEventAt && Date.parse(firstAgentEventAt) <= Date.parse(settled)
    ? firstAgentEventAt : undefined;
  const seconds = (from: string) => Math.max(0, Math.floor((Date.parse(settled) - Date.parse(from)) / 1000));
  const machineId = typeof machine.id === "string" ? machine.id : undefined;
  const nodeId = typeof machine.nodeId === "string" ? machine.nodeId : undefined;
  const attemptId = typeof machine.attemptId === "string" ? machine.attemptId : undefined;
  const usageId = attemptId ?? machineId ?? nodeId;
  if (!usageId) return undefined;
  return {
    accountId, usageId, machineId, nodeId,
    sessionId: typeof machine.sessionId === "string" ? machine.sessionId : undefined,
    launchedAt, firstAgentEventAt: boundedFirst, settledAt: settled,
    machineSeconds: seconds(launchedAt),
    activeAgentSeconds: boundedFirst ? seconds(boundedFirst) : 0,
  };
}

export function usageSecondsWithin(
  record: SessionUsageRecord,
  startsAt: string,
  endsAt: string,
): { machineSeconds: number; activeAgentSeconds: number } {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  const settled = Date.parse(record.settledAt);
  const overlap = (fromIso: string | undefined): number => {
    if (!fromIso) return 0;
    const from = Math.max(Date.parse(fromIso), start);
    const to = Math.min(settled, end);
    return Number.isFinite(from) && Number.isFinite(to) && to > from ? Math.floor((to - from) / 1000) : 0;
  };
  return { machineSeconds: overlap(record.launchedAt), activeAgentSeconds: overlap(record.firstAgentEventAt) };
}
