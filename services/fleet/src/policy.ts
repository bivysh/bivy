// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Who may start a machine, and how much machine time they have left.
//
// The fleet always meters awake time itself (see store.ts) and always applies
// the deployment's own caps (see limits.ts). An operator who sells machine time
// can put a policy service in front: it answers the same questions from its own
// plans and prices, which never enter this repo. The questions are technical
// facts — size, vCPUs, memory, how long, what for — never a tier or a price.

export interface PolicyContext {
  /** Always "managed" from the fleet: this is deployment-supplied compute. */
  computeSource: "managed";
  sizeId?: string;
  vcpus?: number;
  memoryMiB?: number;
  ttlMinutes?: number;
  /** interactive | wake | runner | the acquire purpose. */
  purpose?: string;
  activeManagedMachines?: number;
}

export interface PolicyDecisionAction {
  id: string;
  label: string;
  kind?: "primary" | "secondary";
  confirm?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  code?: string;
  reason?: string;
  usage?: { used: number; limit?: number };
  actions?: PolicyDecisionAction[];
}

/** What the fleet asks before it starts, resizes or keeps a machine running.
 * Only `admit` is required; an absent answer means "no limit of that kind". */
export interface Admission {
  admit(accountId: string, requestId: string, context: PolicyContext): Promise<PolicyDecision>;
  /** Metered seconds left; undefined when the account is unmetered. */
  secondsLeft?(accountId: string): Promise<number | undefined>;
  /** Size classes beyond the fleet's default size that this account may run. */
  sizeClasses?(accountId: string): Promise<string[]>;
  /** May this account grow its disk past the included size? */
  diskAllowed?(accountId: string): Promise<boolean>;
  /** The account's disk is about to change to `extraGb` beyond the included
   * size. Throwing cancels the change, so an operator that charges for disk
   * can refuse before any disk is grown. */
  diskChanged?(accountId: string, extraGb: number): Promise<void>;
  /** Out of allowance with nothing left to come: delete the computer and its
   * disk rather than leave it asleep. */
  retireWhenExhausted?(accountId: string): Promise<boolean>;
  /** An awake period ended, metered in Standard seconds. Best-effort. */
  runSettled?(accountId: string, runId: string, at: string, machineSeconds: number): Promise<void>;
}

/**
 * The deployment's own caps and an operator's policy service, together. Both
 * must allow, so configuring a policy service can never raise a deployment's
 * own ceiling — and an operator that sells machine time can lower it per
 * account. Answers only the operator has (retirement, metering, disk charges)
 * come from it alone.
 */
export function composeAdmission(local: Admission, remote: Admission): Admission {
  return {
    async admit(accountId, requestId, context) {
      const decision = await local.admit(accountId, requestId, context);
      return decision.allowed ? remote.admit(accountId, requestId, context) : decision;
    },
    async secondsLeft(accountId) {
      const [mine, theirs] = await Promise.all([local.secondsLeft?.(accountId), remote.secondsLeft?.(accountId)]);
      const answers = [mine, theirs].filter((value): value is number => value !== undefined);
      return answers.length ? Math.min(...answers) : undefined;
    },
    async sizeClasses(accountId) {
      const [mine, theirs] = await Promise.all([local.sizeClasses?.(accountId) ?? [], remote.sizeClasses?.(accountId)]);
      return theirs === undefined ? mine : mine.filter((size) => theirs.includes(size));
    },
    async diskAllowed(accountId) {
      const [mine, theirs] = await Promise.all([local.diskAllowed?.(accountId) ?? false, remote.diskAllowed?.(accountId) ?? false]);
      return mine && theirs;
    },
    ...(remote.diskChanged ? { diskChanged: remote.diskChanged.bind(remote) } : {}),
    ...(remote.retireWhenExhausted ? { retireWhenExhausted: remote.retireWhenExhausted.bind(remote) } : {}),
    ...(remote.runSettled ? { runSettled: remote.runSettled.bind(remote) } : {}),
  };
}

/** The answers one call brings back, reused briefly. */
interface AccountLimits {
  secondsLeft?: number;
  sizeClasses?: string[];
  diskAllowed?: boolean;
  retireWhenExhausted?: boolean;
}

const LIMITS_REUSE_MS = 30_000;

/**
 * An operator policy service. `admit` goes to the same `/v1/policy/check` a
 * deployment extension already serves for Core; the rest are optional and a
 * 404 reads as "this deployment has no such limit", so a policy service that
 * only admits works unchanged.
 */
export class HttpAdmission implements Admission {
  private readonly cache = new Map<string, { limits: AccountLimits; fetchedAt: number }>();

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now = () => Date.now(),
  ) {
    this.url = url.replace(/\/$/, "");
  }

  async admit(accountId: string, requestId: string, context: PolicyContext): Promise<PolicyDecision> {
    const answer = await this.post("/v1/policy/check", { subject: { accountId }, operation: "ephemeral.provision", idempotencyKey: requestId, context });
    const decision = answer as Partial<PolicyDecision> | undefined;
    // A policy service that cannot answer must not become a way around it.
    if (!decision || typeof decision.allowed !== "boolean") {
      return { allowed: false, code: "policy_unavailable", reason: "The deployment's policy service did not answer." };
    }
    return decision as PolicyDecision;
  }

  async secondsLeft(accountId: string): Promise<number | undefined> {
    return (await this.limits(accountId)).secondsLeft;
  }

  async sizeClasses(accountId: string): Promise<string[]> {
    return (await this.limits(accountId)).sizeClasses ?? [];
  }

  async diskAllowed(accountId: string): Promise<boolean> {
    return (await this.limits(accountId)).diskAllowed === true;
  }

  async retireWhenExhausted(accountId: string): Promise<boolean> {
    return (await this.limits(accountId)).retireWhenExhausted === true;
  }

  async runSettled(accountId: string, runId: string, at: string, machineSeconds: number): Promise<void> {
    await this.post("/v1/policy/compute/runs", { subject: { accountId }, runId, at, machineSeconds });
  }

  async diskChanged(accountId: string, extraGb: number): Promise<void> {
    await this.post("/v1/policy/compute/disk", { subject: { accountId }, extraGb });
    this.cache.delete(accountId);
  }

  /** The account's limits, reused for half a minute. An unreachable service
   * reads as the last answer, else no limits: a policy outage must not stop a
   * machine that is already running. Admission still fails closed. */
  private async limits(accountId: string): Promise<AccountLimits> {
    const hit = this.cache.get(accountId);
    if (hit && this.now() - hit.fetchedAt < LIMITS_REUSE_MS) return hit.limits;
    let answer: unknown;
    try {
      answer = await this.post("/v1/policy/compute/limits", { subject: { accountId } });
    } catch {
      return hit?.limits ?? {};
    }
    const raw = (answer ?? {}) as Record<string, unknown>;
    const limits: AccountLimits = {
      ...(typeof raw.secondsLeft === "number" && Number.isFinite(raw.secondsLeft) ? { secondsLeft: raw.secondsLeft } : {}),
      ...(Array.isArray(raw.sizeClasses) ? { sizeClasses: raw.sizeClasses.filter((c): c is string => typeof c === "string") } : {}),
      ...(typeof raw.diskAllowed === "boolean" ? { diskAllowed: raw.diskAllowed } : {}),
      ...(typeof raw.retireWhenExhausted === "boolean" ? { retireWhenExhausted: raw.retireWhenExhausted } : {}),
    };
    this.cache.set(accountId, { limits, fetchedAt: this.now() });
    return limits;
  }

  /** undefined when the deployment does not serve this question. */
  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) return undefined;
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok && response.status !== 429) throw new Error(data.error || `Policy service failed (${response.status})`);
    return data;
  }
}
