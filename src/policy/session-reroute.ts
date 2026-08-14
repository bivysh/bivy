// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Session effector — in-session model reroute.
//
// The queue effector (src/control-plane-tasks.ts) reruns a failed item under the
// run policy. This is the interactive-session counterpart, scoped to the ONE
// action a live session can take fully in-place: swapping the model. When a turn
// ends in a recoverable error (credits exhausted, rate-limited) and the session
// ruleset says `reroute` down a model chain, this swaps the model via the
// runtime's `setModel` and re-sends the same prompt — so the session continues on
// a cheaper/other model instead of surfacing an error.
//
// It deliberately does NOT handle agent (runtime) or node reroutes: those are
// forks / standby promotions (new session identity, possibly reduced fidelity),
// not in-place swaps — a separate, heavier effector (see docs/rulesets.md). A
// chain candidate that changes anything other than the model is skipped here and
// the error is left to surface.
//
// The decision is SYNCHRONOUS (`planReroute`) so the caller can atomically decide
// whether to suppress the turn's error toast before kicking off the async swap +
// retry (`applyReroute`). Reroute happens only at the turn boundary, so there is
// no partial-work hazard.
//
// It also plans the OTHER in-place recovery a live session can do: waiting out a
// provider usage/rate limit and re-sending the same prompt when the window
// resets (`planResume`). Unlike a reroute (which the controller applies itself),
// a resume can be hours away and must survive a daemon restart, so scheduling +
// persistence live in the caller (src/server.ts) — the controller only decides
// whether a resume is warranted and by when.

import type { RunPolicy } from "./run-policy.js";

/** The minimal live-session surface the controller drives. */
export interface SessionRerouteTarget {
  getCurrentModelName(): string | undefined;
  setModel(provider: string, id: string): Promise<void>;
  /** Re-send the turn's last prompt (starts a fresh turn on the new model). */
  reprompt(): Promise<void>;
}

/** A resolved in-place model swap to apply for the current turn. */
export interface ReroutePlan {
  model: string;
  condition: string;
  summary: string;
  delayMs: number;
  rerouteCount: number;
}

/** A resolved "wait out the limit, then re-send the same prompt" recovery. The
 *  caller schedules it (durably) and re-drives the turn when it comes due. */
export interface ResumePlan {
  condition: string;
  summary: string;
  /** How long from now until the retry should fire. */
  delayMs: number;
  /** ISO instant the retry is due — the reset time when the provider gave one,
   *  else `now + delayMs`. What the caller persists so the resume survives a
   *  restart. */
  resumeAt: string;
}

/** Below this, a "retry" is ordinary backoff (seconds) — not worth deferring an
 *  interactive turn for; let it surface. A real usage/rate window reset is
 *  minutes-to-days out and always clears this bar. */
const MIN_RESUME_DELAY_MS = 60_000;

export interface SessionRerouteDeps {
  policy: RunPolicy;
  /** Injectable delay for backoff waits (deterministic in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Surface a status notice to the session's UI (e.g. "Switching to …"). */
  onNotice?: (n: { level: "info" | "warn"; message: string }) => void;
  /** Record a bounded, privacy-safe timeline event (e.g. a `fallback`). */
  onEvent?: (e: { kind: "fallback"; summary: string }) => void;
  /** Called after the model has actually changed, so the UI can refresh. */
  onModelChanged?: () => void;
  /** Called when the swap itself failed (e.g. model not available on the node). */
  onFailed?: (message: string) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SessionRerouteController {
  private attempt = 1;
  private rerouteCount = 0;
  private applying = false;

  constructor(private readonly deps: SessionRerouteDeps) {}

  /** Reset the reroute budget at the start of each new user-initiated turn. */
  beginTurn(): void {
    this.attempt = 1;
    this.rerouteCount = 0;
  }

  /**
   * Synchronously decide whether this turn error should become an in-place model
   * reroute. Returns a plan (the caller should suppress the error toast and call
   * `applyReroute`) or null (let the error surface as usual). Pure w.r.t. the
   * controller's counters — those advance only when the plan is applied.
   */
  planReroute(rawError: unknown, currentModel: string | undefined): ReroutePlan | null {
    if (this.applying) return null;
    const decision = this.deps.policy.decide({
      routing: { model: currentModel },
      error: rawError,
      attempt: this.attempt,
      rerouteCount: this.rerouteCount,
    });
    if (decision.action !== "reroute") return null;
    return this.rerouteFrom(decision, currentModel);
  }

  /**
   * Decide whether this turn error should be recovered by WAITING for a provider
   * usage/rate limit to reset and re-sending the same prompt. Returns a plan the
   * caller should persist + schedule, or null (surface the error as usual).
   *
   * `resetsAtHint` is the authoritative reset time when the caller has one (the
   * provider's structured usage snapshot) — essential for a multi-day "weekly"
   * window, whose error text only states a time-of-day. `now` is injectable for
   * deterministic tests. Pure w.r.t. the controller's counters.
   */
  planResume(
    rawError: unknown,
    currentModel: string | undefined,
    opts: { resetsAtHint?: string; now?: number } = {},
  ): ResumePlan | null {
    if (this.applying) return null;
    const now = opts.now ?? Date.now();
    const decision = this.deps.policy.decide({
      routing: { model: currentModel },
      error: rawError,
      attempt: this.attempt,
      rerouteCount: this.rerouteCount,
      resetsAtHint: opts.resetsAtHint,
    });
    if (decision.action !== "retry") return null;
    // Only defer for a concrete recovery window — a provider reset, or a delay
    // long enough that it's clearly a limit rather than routine backoff.
    if (decision.resetsAt === undefined && decision.delayMs < MIN_RESUME_DELAY_MS) return null;
    // Resolve the due time (provider reset when known, else backoff) and floor it
    // to at least MIN_RESUME_DELAY_MS in the FUTURE. A reset time can be in the
    // past or ~now — a stale/elapsed reset, clock skew, or (most often) a window
    // that already lapsed while the daemon was down — and using it verbatim yields
    // a 0ms delay. The caller arms a timer at that delay, so a 0ms resume re-sends
    // instantly, re-hits the still-standing limit, and re-schedules 0ms again: a
    // tight loop that pins a CPU core and never settles. Flooring turns a
    // not-yet-cleared limit into a slow retry the attempt budget can still park.
    const rawDueMs = decision.resetsAt ? Date.parse(decision.resetsAt) : now + decision.delayMs;
    const dueMs = Math.max(Number.isFinite(rawDueMs) ? rawDueMs : now, now + MIN_RESUME_DELAY_MS);
    return {
      condition: decision.condition,
      summary: decision.summary,
      delayMs: dueMs - now,
      resumeAt: new Date(dueMs).toISOString(),
    };
  }

  /** Advance the attempt budget once the caller has committed to a resume, so a
   *  limit that re-fires after the reset counts toward `maxAttempts` and can
   *  eventually exhaust (→ park) instead of looping forever. */
  noteResumeApplied(): void {
    this.attempt += 1;
  }

  private rerouteFrom(decision: ReturnType<RunPolicy["decide"]>, currentModel: string | undefined): ReroutePlan | null {
    if (decision.action !== "reroute") return null;
    const model = decision.routing.model;
    // Only a MODEL change is applicable in-session; a chain candidate that swaps
    // agent/account/node (or is a no-op) is left to surface / a future effector.
    if (!model || model === currentModel) return null;
    return {
      model,
      condition: decision.condition,
      summary: decision.summary,
      delayMs: decision.delayMs,
      rerouteCount: decision.rerouteCount,
    };
  }

  /** Apply a plan: swap the model and re-drive the turn. Best-effort; on a failed
   *  swap it reports via `onFailed` rather than throwing. */
  async applyReroute(plan: ReroutePlan, target: SessionRerouteTarget): Promise<void> {
    if (this.applying) return;
    this.applying = true;
    try {
      this.deps.onEvent?.({ kind: "fallback", summary: plan.summary });
      this.deps.onNotice?.({
        level: "info",
        message: `Switching to ${plan.model} after ${plan.condition.replace(/_/g, " ")}, then retrying…`,
      });
      if (plan.delayMs > 0) await (this.deps.sleep ?? defaultSleep)(plan.delayMs);
      await target.setModel("", plan.model);
      this.deps.onModelChanged?.();
      this.attempt += 1;
      this.rerouteCount = plan.rerouteCount;
      await target.reprompt();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.onFailed?.(`Couldn't reroute to ${plan.model}: ${message}`);
    } finally {
      this.applying = false;
    }
  }
}
