// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The deployment's own caps, applied by the fleet itself. These exist so that
// running a fleet for other people is safe without any further service: a
// runaway account cannot spend the operator's provider budget or fill the org
// with machines. They are quantities of compute — hours, machines, sizes — and
// carry no notion of a plan or a price.

import type { Admission, PolicyContext, PolicyDecision } from "./policy.js";
import { SIZES, type SizeClass } from "./sizes.js";
import type { FleetStore } from "./store.js";

export interface FleetLimits {
  /** Machines the whole fleet may run at once, counting computers and runners.
   * 0 means no cap. */
  maxMachines: number;
  /** Runners one account may have awake beside its computer. */
  maxRunnersPerAccount: number;
  /** Metered hours an account gets each calendar month. 0 means unmetered. */
  monthlyHours: number;
  /** Size classes an account may pick beyond the fleet's default size. */
  sizeClasses: SizeClass[];
  /** The largest disk an account may grow to. Equal to the included size means
   * the disk never grows. */
  maxDiskGb: number;
  includedDiskGb: number;
}

/** Start of the current calendar month, UTC. */
function monthStart(now: number): string {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

export class LocalAdmission implements Admission {
  constructor(
    private readonly store: FleetStore,
    private readonly limits: FleetLimits,
    private readonly now = () => Date.now(),
  ) {}

  async admit(accountId: string, _requestId: string, context: PolicyContext): Promise<PolicyDecision> {
    const { maxMachines, maxRunnersPerAccount, monthlyHours } = this.limits;
    if (context.purpose === "runner" && maxRunnersPerAccount <= 0) {
      return { allowed: false, code: "runners_disabled", reason: "This deployment runs no runners." };
    }
    if (context.purpose === "runner") {
      const awake = (await this.store.listRunners(accountId)).filter((runner) => runner.state !== "asleep").length;
      if (awake >= maxRunnersPerAccount) {
        return {
          allowed: false, code: "concurrent_runners", usage: { used: awake, limit: maxRunnersPerAccount },
          reason: `You already have ${awake} runners working. Wait for one to finish.`,
        };
      }
    }
    if (maxMachines > 0) {
      const running = (await this.store.list()).length + (await this.store.listRunners()).length;
      if (running >= maxMachines) {
        return {
          allowed: false, code: "fleet_full", usage: { used: running, limit: maxMachines },
          reason: "This deployment's machine limit is reached. Try again shortly.",
        };
      }
    }
    if (monthlyHours > 0) {
      const left = await this.secondsLeft(accountId);
      if (left !== undefined && left <= 0) {
        return {
          allowed: false, code: "machine_time", usage: { used: monthlyHours * 3600, limit: monthlyHours * 3600 },
          reason: "This month's machine time is used up. It resets at the start of next month.",
        };
      }
    }
    return { allowed: true };
  }

  async secondsLeft(accountId: string): Promise<number | undefined> {
    const { monthlyHours } = this.limits;
    if (monthlyHours <= 0) return undefined;
    const used = await this.store.usedSeconds(accountId, monthStart(this.now()));
    return Math.max(0, monthlyHours * 3600 - used);
  }

  async sizeClasses(): Promise<string[]> {
    return this.limits.sizeClasses;
  }

  async diskAllowed(): Promise<boolean> {
    return this.limits.maxDiskGb > this.limits.includedDiskGb;
  }
}

/** The size classes named in configuration, ignoring unknown ones. */
export function sizeClassesFrom(raw: string | undefined): SizeClass[] {
  const known = new Set(Object.values(SIZES).map((size) => size.class));
  const named = (raw ?? "").split(/[,\s]+/).map((value) => value.trim().toLowerCase()).filter(Boolean);
  return [...new Set(named.filter((value): value is SizeClass => known.has(value as SizeClass)))];
}
