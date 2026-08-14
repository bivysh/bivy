// SPDX-License-Identifier: AGPL-3.0-only
import { CronExpressionParser } from "cron-parser";
import type { AutomationDefinition, AutomationRun } from "./store.js";

export interface ScheduleStore {
  listDueAutomationDefinitions(nowIso: string, limit?: number): Promise<AutomationDefinition[]>;
  enqueueScheduledOccurrence(accountId: string, definitionId: string, occurrenceIso: string, nextRunAt?: string): Promise<AutomationRun | undefined>;
}

export type ScheduleSpec = NonNullable<AutomationDefinition["schedule"]>;

export function validateTimezone(timezone: string): string {
  const value = timezone.trim();
  if (!value) throw new Error("A timezone is required.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new Error(`Invalid timezone: ${value}`);
  }
  return value;
}

export function normalizeSchedule(value: unknown): ScheduleSpec {
  if (!value || typeof value !== "object") throw new Error("A schedule is required.");
  const input = value as Record<string, unknown>;
  if (input.kind === "once") {
    if (typeof input.at !== "string") throw new Error("A one-time schedule needs an ISO timestamp.");
    const at = new Date(input.at);
    if (!Number.isFinite(at.getTime()) || !/T/.test(input.at)) throw new Error("Invalid ISO timestamp.");
    return { kind: "once", at: at.toISOString() };
  }
  if (input.kind === "cron") {
    if (typeof input.expression !== "string") throw new Error("A cron expression is required.");
    const expression = input.expression.trim();
    const timezone = validateTimezone(typeof input.timezone === "string" ? input.timezone : "");
    try {
      CronExpressionParser.parse(expression, { tz: timezone });
    } catch {
      throw new Error("Invalid cron expression. Use a standard five-field cron expression.");
    }
    return { kind: "cron", expression, timezone };
  }
  throw new Error("Schedule kind must be once or cron.");
}

export function nextOccurrence(schedule: ScheduleSpec, after = new Date()): string | undefined {
  if (schedule.kind === "once") {
    const at = new Date(schedule.at);
    return at.getTime() > after.getTime() ? at.toISOString() : undefined;
  }
  return CronExpressionParser.parse(schedule.expression, {
    currentDate: after,
    tz: schedule.timezone,
  }).next().toDate().toISOString();
}

/**
 * Catch-up policy: enqueue only the earliest missed occurrence, then advance
 * from "now". This avoids a restart storm while retaining one durable run for
 * work that became due while the control plane was offline.
 *
 * `onEnqueued` fires per created run so callers can poke connected relays for
 * near-instant pickup instead of waiting for the node's poll interval.
 */
export async function processDueSchedules(
  store: ScheduleStore,
  now = new Date(),
  onEnqueued?: (accountId: string, run: AutomationRun) => void,
): Promise<number> {
  const due = await store.listDueAutomationDefinitions(now.toISOString());
  let enqueued = 0;
  for (const definition of due) {
    if (!definition.enabled || !definition.nextRunAt || !definition.schedule) continue;
    const next = definition.schedule.kind === "cron" ? nextOccurrence(definition.schedule, now) : undefined;
    const run = await store.enqueueScheduledOccurrence(definition.accountId, definition.id, definition.nextRunAt, next);
    if (run) {
      enqueued += 1;
      onEnqueued?.(definition.accountId, run);
    }
  }
  return enqueued;
}

export class AutomationScheduler {
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly store: ScheduleStore,
    private readonly intervalMs = 15_000,
    private readonly onEnqueued?: (accountId: string, run: AutomationRun) => void,
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      return await processDueSchedules(this.store, now, this.onEnqueued);
    } finally {
      this.ticking = false;
    }
  }
}
