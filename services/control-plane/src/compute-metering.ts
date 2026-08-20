// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type {
  Account,
  ComputeUsageRepository,
  EphemeralNodeConfig,
  HostedAuditEvent,
  SessionUsageRecord,
} from "./store.js";

export const COMPUTE_PLAN_IDS = ["free", "individual", "pro", "team"] as const;
export type ComputePlanId = (typeof COMPUTE_PLAN_IDS)[number];

export interface ComputePlanCaps {
  maxConcurrentManagedSessions: number;
  monthlyActiveAgentSeconds: number;
  maxTtlMinutes: number;
}

/** Managed-compute limits are product data. Adding or tuning a plan is a table
 * change, not another provisioning branch. Seconds are used throughout so the
 * gate and persisted meter do not lose precision through hour conversions. */
export const COMPUTE_PLAN_CAPS: Readonly<Record<ComputePlanId, ComputePlanCaps>> = {
  free: { maxConcurrentManagedSessions: 0, monthlyActiveAgentSeconds: 0, maxTtlMinutes: 0 },
  individual: { maxConcurrentManagedSessions: 2, monthlyActiveAgentSeconds: 20 * 3600, maxTtlMinutes: 120 },
  pro: { maxConcurrentManagedSessions: 4, monthlyActiveAgentSeconds: 100 * 3600, maxTtlMinutes: 240 },
  team: { maxConcurrentManagedSessions: 10, monthlyActiveAgentSeconds: 500 * 3600, maxTtlMinutes: 480 },
};

export type ComputeCapDenialCode = "concurrent_sessions" | "monthly_active_agent_time" | "session_ttl" | "metering_unavailable";
export interface ComputeCapDenial {
  allowed: false;
  code: ComputeCapDenialCode;
  message: string;
  limit: number;
  used?: number;
}
export type ComputeCapDecision = { allowed: true } | ComputeCapDenial;

export interface CurrentComputeUsage {
  activeAgentSeconds: number;
  concurrentManagedSessions: number;
}
export interface ComputeLaunchRequest { ttlMinutes: number }

export function normalizeComputePlan(plan: Account["plan"] | string | null | undefined): ComputePlanId {
  return COMPUTE_PLAN_IDS.includes(plan as ComputePlanId) ? plan as ComputePlanId : "free";
}

export function evaluateComputeCaps(
  plan: ComputePlanId,
  currentUsage: CurrentComputeUsage,
  request: ComputeLaunchRequest,
): ComputeCapDecision {
  const caps = COMPUTE_PLAN_CAPS[plan];
  if (currentUsage.concurrentManagedSessions >= caps.maxConcurrentManagedSessions) {
    return {
      allowed: false, code: "concurrent_sessions",
      message: caps.maxConcurrentManagedSessions === 0
        ? "Managed compute is not included in this plan."
        : `This plan allows ${caps.maxConcurrentManagedSessions} concurrent managed sessions.`,
      limit: caps.maxConcurrentManagedSessions, used: currentUsage.concurrentManagedSessions,
    };
  }
  if (currentUsage.activeAgentSeconds >= caps.monthlyActiveAgentSeconds) {
    return {
      allowed: false, code: "monthly_active_agent_time",
      message: caps.monthlyActiveAgentSeconds === 0
        ? "Managed compute is not included in this plan."
        : "This plan's monthly active-agent time has been used.",
      limit: caps.monthlyActiveAgentSeconds, used: currentUsage.activeAgentSeconds,
    };
  }
  if (request.ttlMinutes > caps.maxTtlMinutes) {
    return {
      allowed: false, code: "session_ttl",
      message: `This plan allows a maximum session TTL of ${caps.maxTtlMinutes} minutes.`,
      limit: caps.maxTtlMinutes, used: request.ttlMinutes,
    };
  }
  return { allowed: true };
}

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

/** Convert durable lifecycle facts into one immutable settlement estimate. The
 * first-agent boundary is deliberately retained on the record so per-turn
 * accrual can replace this v1 estimate without changing launch admission. */
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

export function usageSecondsWithin(record: SessionUsageRecord, startsAt: string, endsAt: string): { machineSeconds: number; activeAgentSeconds: number } {
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

export interface AccountUsageSummary {
  month: { startsAt: string; endsAt: string };
  plan: ComputePlanId;
  totals: { machineSeconds: number; activeAgentSeconds: number };
  caps: ComputePlanCaps;
  remaining: { activeAgentSeconds: number; concurrentManagedSessions: number };
  concurrentManagedSessions: number;
  sessions: Array<{
    usageId: string; sessionId?: string; machineId?: string;
    launchedAt: string; firstAgentEventAt?: string; settledAt: string;
    machineSeconds: number; activeAgentSeconds: number;
  }>;
}

export function summarizeAccountUsage(
  planValue: Account["plan"] | string | undefined,
  records: SessionUsageRecord[],
  concurrentManagedSessions: number,
  nowMs = Date.now(),
  recentLimit = 20,
): AccountUsageSummary {
  const month = utcMonthWindow(nowMs);
  const plan = normalizeComputePlan(planValue);
  const caps = COMPUTE_PLAN_CAPS[plan];
  const apportioned = records.map((record) => ({ record, usage: usageSecondsWithin(record, month.startsAt, month.endsAt) }));
  const totals = apportioned.reduce((sum, row) => ({
    machineSeconds: sum.machineSeconds + row.usage.machineSeconds,
    activeAgentSeconds: sum.activeAgentSeconds + row.usage.activeAgentSeconds,
  }), { machineSeconds: 0, activeAgentSeconds: 0 });
  return {
    month, plan, totals, caps,
    remaining: {
      activeAgentSeconds: Math.max(0, caps.monthlyActiveAgentSeconds - totals.activeAgentSeconds),
      concurrentManagedSessions: Math.max(0, caps.maxConcurrentManagedSessions - concurrentManagedSessions),
    },
    concurrentManagedSessions,
    sessions: apportioned.slice(0, Math.max(0, recentLimit)).map(({ record, usage }) => ({
      usageId: record.usageId, sessionId: record.sessionId, machineId: record.machineId,
      launchedAt: record.launchedAt, firstAgentEventAt: record.firstAgentEventAt,
      settledAt: record.settledAt, ...usage,
    })),
  };
}

export function isManagedComputeSource(source: unknown): boolean {
  return source === "managed";
}

export interface ManagedComputeGateStore extends ComputeUsageRepository {
  getAccount(accountId: string): Promise<Account | undefined>;
  getHostedMachines(accountId: string): Promise<Array<Record<string, unknown>>>;
  appendHostedAudit(accountId: string, event: HostedAuditEvent): Promise<void>;
}

/** Single provisioning-path integration point. BYO providers return immediately;
 * managed launches deny on every meter/account read error and emit audit evidence. */
export async function enforceManagedComputeLaunch(
  store: ManagedComputeGateStore,
  accountId: string,
  config: EphemeralNodeConfig,
  nowMs = Date.now(),
): Promise<ComputeCapDecision> {
  if (!isManagedComputeSource(config.computeSource)) return { allowed: true };
  try {
    const window = utcMonthWindow(nowMs);
    const [account, records, machines] = await Promise.all([
      store.getAccount(accountId),
      store.listSessionUsage(accountId, window.startsAt, window.endsAt),
      store.getHostedMachines(accountId),
    ]);
    if (!account) throw new Error("account not found");
    const activeAgentSeconds = records.reduce((total, row) => total + usageSecondsWithin(row, window.startsAt, window.endsAt).activeAgentSeconds, 0);
    const concurrentManagedSessions = machines.filter((machine) => isManagedComputeSource(machine.computeSource)).length;
    const decision = evaluateComputeCaps(normalizeComputePlan(account.plan), { activeAgentSeconds, concurrentManagedSessions }, { ttlMinutes: config.ttlMinutes ?? 60 });
    if (!decision.allowed) {
      await store.appendHostedAudit(accountId, { at: new Date(nowMs).toISOString(), action: "compute_cap_denied", provider: config.provider, configId: config.id, detail: decision.code }).catch(() => {});
    }
    return decision;
  } catch {
    const denial: ComputeCapDenial = { allowed: false, code: "metering_unavailable", message: "Managed compute is temporarily unavailable because usage could not be verified.", limit: 0 };
    await store.appendHostedAudit(accountId, { at: new Date(nowMs).toISOString(), action: "compute_cap_denied", provider: config.provider, configId: config.id, detail: denial.code }).catch(() => {});
    return denial;
  }
}
