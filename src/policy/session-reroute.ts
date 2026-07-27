// SPDX-License-Identifier: FSL-1.1-ALv2
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
