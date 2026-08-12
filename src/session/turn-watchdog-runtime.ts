// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

import { classifyStallTrigger, type StallTrigger } from "./turn-watchdog.js";

/**
 * The stateful half of the turn watchdog — the timer/stall orchestration that
 * used to live inline in server.ts. The pure config parsing and stall
 * classification stay in ./turn-watchdog.js; this module owns the effectful
 * part: arming the wall-clock timer, sweeping for stalled turns, and running the
 * shared force-recovery path.
 *
 * It deliberately depends on a NARROW session shape (WatchdogSession) rather than
 * the server's ~50-field SessionRecord god-object, and reaches the rest of the
 * daemon only through the injected WatchdogDeps. That makes the watchdog's entire
 * coupling surface explicit and lets it unit-test with fakes instead of a live
 * server. SessionRecord structurally satisfies WatchdogSession.
 */

/** Only the session fields the watchdog reads or owns. The `turn*` fields are
 *  the watchdog's own per-turn timer state (written here); the rest are progress
 *  anchors and status flags it reads to decide whether a turn is stuck. */
export interface WatchdogSession {
  id: string;
  runtimeId: string;
  agentServiceAddress?: string;
  session: {
    // Method syntax (bivariant) so a concrete RuntimeSession satisfies this.
    prompt(text: string, options?: unknown): Promise<void>;
    activePid?(): number | undefined;
  };
  workingStartedAt?: number;
  lastProgressAt?: number;
  lastStructuralProgressAt?: number;
  lastFailureAt?: number;
  paused?: boolean;
  tuiTermId?: string;
  tuiRefreshing?: boolean;
  abortRecovery?: Promise<void>;
  // Watchdog-owned turn timer state.
  turnWatchdog?: NodeJS.Timeout;
  turnTimeoutSignal?: Promise<void>;
  turnTimeoutResolve?: () => void;
  turnTimedOut?: boolean;
  /** Set when a soft stall (stalled/wedged) was flagged for the user to Stop or
   *  keep going instead of being force-killed. Presence gates re-flagging and
   *  drives the needs_attention projection. */
  turnAttention?: { trigger: StallTrigger; idleMs: number; at: number };
}

/** What the watchdog does when a soft stall (silence or wedged) is detected:
 *  - `notify`  — flag the turn for review (notification + Stop/keep-going card),
 *                never auto-kill; the wall-clock cap remains the backstop.
 *  - `recover` — the legacy behavior: force-recover (kill + reopen) immediately. */
export type StallAction = "notify" | "recover";

/** Everything the watchdog needs from the rest of the daemon. Making this an
 *  explicit object is the point: the hub coupling that was invisible inline is
 *  now one readable interface. */
export interface WatchdogDeps {
  /** Wall-clock cap (ms) for a single turn; 0 disables the cap. */
  turnTimeoutMs: number;
  /** Silence-stall window (ms); 0 disables the idle check. */
  turnStallMs: number;
  /** Wedged/structural-stall window (ms); 0 disables the wedged band. */
  turnActivityStallMs: number;
  /** How a detected soft stall is handled — notify-and-ask (default) vs the legacy
   *  force-recover. `pid_dead` and the wall-clock cap always auto-recover. */
  stallAction: StallAction;
  broadcast(payload: unknown): void;
  /** Re-broadcast the session's derived state (so a flag/clear flips the
   *  needs_attention projection without a runtime event to carry it). */
  broadcastSessionState(record: WatchdogSession): void;
  /** Send a push-notification hint so the user learns a turn needs their decision
   *  even when they aren't looking at the session. Best-effort. */
  notifyTurnAttention(record: WatchdogSession, message: string): void;
  /** Mark the session failed in the metadata store (was metadata.touchSession(id,"failed")). */
  markSessionFailed(id: string): void;
  /** Settle + abort + reopen so the session lands at a clean, resumable idle. */
  abortSessionRecord(record: WatchdogSession): void;
  evaluateEphemeralTeardown(): void;
  /** Whether the session's turn is currently running (isWorking || isStreaming). */
  sessionBusy(record: WatchdogSession): boolean;
  /** Whether the session is blocked on the human (approval/question) — never stalled. */
  sessionHasPendingApproval(record: WatchdogSession): boolean;
  /** The live sessions the periodic sweep should scan. */
  listSessions(): Iterable<WatchdogSession>;
  now?(): number;
}

export interface TurnWatchdog {
  armTurnWatchdog(record: WatchdogSession): void;
  clearTurnWatchdog(record: WatchdogSession): void;
  promptWithWatchdog(record: WatchdogSession, prompt: string, options?: unknown): Promise<void>;
  recoverStuckTurn(record: WatchdogSession, reason: string, diag?: { trigger: StallTrigger; idleMs?: number }): void;
  recoverStalledBeforePrompt(record: WatchdogSession): Promise<void>;
  stallTriggerFor(record: WatchdogSession, now?: number): StallTrigger | null;
  sweepStalledTurns(): void;
  turnRecoveryStats(): Record<string, number>;
  /** Resolve a pending stall review: "stop" runs the force-recovery, "continue"
   *  vouches the turn is healthy — reset the progress anchors and dismiss. */
  resolveTurnAttention(record: WatchdogSession, action: "stop" | "continue"): void;
  /** Dismiss a pending stall review because the turn made (relevant) progress or
   *  ended on its own. `structural` distinguishes a wedged flag (needs structural
   *  progress) from a silence flag (any progress clears it). */
  clearTurnAttentionOnProgress(record: WatchdogSession, structural: boolean): void;
}

/**
 * Is the turn's subprocess still alive? Returns undefined when it can't be told
 * locally — a remote agent-service session runs on another host, and a session
 * with no active pid has no process to probe (the idle timer decides those). A
 * `false` result (pid present but gone) is an unambiguous "stuck" signal the
 * stall check acts on quickly. A shared session-liveness primitive: both the
 * stall sweep and the daemon's session-state derivation read it.
 */
export function probeTurnPidAlive(record: Pick<WatchdogSession, "agentServiceAddress" | "session">): boolean | undefined {
  if (record.agentServiceAddress) return undefined; // process lives on another node
  const pid = record.session.activePid?.();
  if (!pid) return undefined;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, kills nothing
    return true;
  } catch (error) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createTurnWatchdog(deps: WatchdogDeps): TurnWatchdog {
  const { turnTimeoutMs, turnStallMs, turnActivityStallMs } = deps;
  const now = () => (deps.now ? deps.now() : Date.now());

  function turnTimeoutMessage(): string {
    return `Agent turn timed out after ${Math.round(turnTimeoutMs / 60_000)} minutes and was stopped.`;
  }

  function clearTurnWatchdog(record: WatchdogSession): void {
    if (record.turnWatchdog) clearTimeout(record.turnWatchdog);
    record.turnWatchdog = undefined;
    record.turnTimeoutSignal = undefined;
    record.turnTimeoutResolve = undefined;
  }

  function armTurnWatchdog(record: WatchdogSession): void {
    clearTurnWatchdog(record);
    record.turnTimedOut = false;
    if (turnTimeoutMs <= 0) return;
    record.turnTimeoutSignal = new Promise<void>((resolve) => { record.turnTimeoutResolve = resolve; });
    record.turnWatchdog = setTimeout(() => {
      record.turnWatchdog = undefined;
      // Unblock any prompt() awaiting the race in promptWithWatchdog, then run the
      // shared recovery (settle + abort + reopen) so the session lands back at a
      // clean, resumable idle instead of merely "stopped".
      record.turnTimeoutResolve?.();
      record.turnTimeoutResolve = undefined;
      recoverStuckTurn(record, turnTimeoutMessage(), { trigger: "wall_clock", idleMs: now() - (record.workingStartedAt ?? now()) });
    }, turnTimeoutMs);
    record.turnWatchdog.unref?.();
  }

  /** Message for a session recovered because it stopped making progress. A wedged
   *  turn was still emitting output, so word it as "no progress" rather than the
   *  "no activity" the silence stall reports. */
  function turnStallMessage(idleMs: number, trigger: StallTrigger = "stalled"): string {
    const mins = Math.round(idleMs / 60_000);
    if (trigger === "wedged") return `A tool call ran for ${mins} min without making progress and was recovered. Send a message to continue.`;
    return `The agent stopped responding (no activity for ${mins} min) and was recovered. Send a message to continue.`;
  }

  function turnAttentionMessage(idleMs: number, trigger: StallTrigger): string {
    const mins = Math.max(1, Math.round(idleMs / 60_000));
    if (trigger === "wedged") return `A tool call has run for ${mins} min without making progress. Stop it or keep waiting?`;
    return `The agent has been quiet for ${mins} min. Stop it or keep waiting?`;
  }

  /** Idle used for a stall's diagnostic/message. A `wedged` turn is measured from
   *  the last STRUCTURAL progress (raw output kept flowing), every other trigger
   *  from the last progress of any kind. */
  function stallIdleMs(record: WatchdogSession, trigger: StallTrigger, at: number): number {
    const anchor = trigger === "wedged"
      ? record.lastStructuralProgressAt ?? record.workingStartedAt ?? at
      : record.lastProgressAt ?? record.workingStartedAt ?? at;
    return at - anchor;
  }

  // Aggregate turn-recovery counters, keyed `"<runtimeId>:<trigger>"`. A privacy-
  // safe histogram (counts only, no session content) surfaced in the redacted
  // /api/diagnostics health bag so operators can see which runtime hangs and how.
  // See docs/session-reliability-plan.md (Phase 1).
  const turnRecoveryCounts = new Map<string, number>();
  function recordTurnRecovery(runtimeId: string, trigger: StallTrigger): void {
    const key = `${runtimeId}:${trigger}`;
    turnRecoveryCounts.set(key, (turnRecoveryCounts.get(key) ?? 0) + 1);
  }
  function turnRecoveryStats(): Record<string, number> {
    return Object.fromEntries([...turnRecoveryCounts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  /**
   * Force-recover a session whose turn is stuck — hit the wall-clock cap, went
   * silent past the stall window, or lost its subprocess without emitting
   * agent_end. Shared by the turn-watchdog timer, the stall sweep, and the
   * prompt-time guard so every path settles identically: mark the failure for the
   * client, then run the full abort→reopen recovery so the session returns to a
   * clean, resumable idle state rather than a wedged "working". Idempotent: a
   * second call while recovery is already in flight is a no-op.
   */
  function recoverStuckTurn(record: WatchdogSession, reason: string, diag?: { trigger: StallTrigger; idleMs?: number }): void {
    if (record.turnTimedOut) return; // already recovering this turn
    record.turnTimedOut = true;
    // A real recovery (user hit Stop, wall-clock cap, or a dead subprocess)
    // supersedes any pending "needs your decision" card — drop it so the client
    // closes it and the failed/outcome events below take over.
    record.turnAttention = undefined;
    record.lastFailureAt = now();
    const trigger = diag?.trigger ?? "stalled";
    const turnMs = record.workingStartedAt ? record.lastFailureAt - record.workingStartedAt : undefined;
    console.warn(`[turn-watchdog] recovering stuck session ${record.id} (runtime=${record.runtimeId} trigger=${trigger}): ${reason}`);
    // Attribute the recovery so operators can see WHICH runtime/transport hangs and
    // how (subprocess died vs went silent vs hit the wall-clock cap) instead of
    // losing it to a log line — see docs/session-reliability-plan.md (Phase 1).
    recordTurnRecovery(record.runtimeId, trigger);
    deps.broadcast({
      type: "session.diagnostic",
      sessionId: record.id,
      kind: "turn_recovered",
      runtimeId: record.runtimeId,
      trigger,
      ...(diag?.idleMs != null ? { idleMs: diag.idleMs } : {}),
      ...(turnMs != null ? { turnMs } : {}),
      at: record.lastFailureAt,
    });
    deps.markSessionFailed(record.id);
    deps.broadcast({ type: "session.failed", sessionId: record.id, failedAt: record.lastFailureAt });
    deps.broadcast({ type: "session.outcome", sessionId: record.id, status: "timed_out", completedAt: new Date(record.lastFailureAt).toISOString(), error: reason });
    deps.broadcast({ type: "session.error", sessionId: record.id, error: reason });
    // Settle the client, force the runtime abort (SIGKILL escalation guarantees the
    // wedged child dies), and reopen so a follow-up prompt runs a fresh turn.
    deps.abortSessionRecord(record);
    deps.evaluateEphemeralTeardown();
  }

  /** Which stall condition (if any) a working session's current turn has hit —
   *  the diagnostic trigger the recovery path attributes per runtime. A session
   *  waiting on the human (pending approval/question), paused, or locked to its
   *  TUI is deliberately never counted as stalled — it's not hung. */
  function stallTriggerFor(record: WatchdogSession, at = now()): StallTrigger | null {
    if (turnStallMs <= 0 && turnActivityStallMs <= 0) return null;
    if (!deps.sessionBusy(record)) return null;
    if (record.turnTimedOut) return null; // recovery already running
    if (record.paused) return null;
    if (record.tuiTermId || record.tuiRefreshing) return null; // driven from the terminal
    if (deps.sessionHasPendingApproval(record)) return null; // waiting on the user, not hung
    const lastProgressAt = record.lastProgressAt ?? record.workingStartedAt ?? at;
    const lastStructuralProgressAt = record.lastStructuralProgressAt ?? record.workingStartedAt ?? at;
    return classifyStallTrigger({
      now: at,
      lastProgressAt,
      stallMs: turnStallMs,
      pidAlive: probeTurnPidAlive(record),
      lastStructuralProgressAt,
      activityStallMs: turnActivityStallMs,
    });
  }

  function clearTurnAttention(record: WatchdogSession): void {
    if (!record.turnAttention) return;
    record.turnAttention = undefined;
    deps.broadcast({ type: "session.turn_attention.resolved", sessionId: record.id });
    deps.broadcastSessionState(record);
  }

  function flagTurnForReview(record: WatchdogSession, trigger: StallTrigger, idleMs: number, at: number): void {
    if (record.turnAttention) return;
    const message = turnAttentionMessage(idleMs, trigger);
    record.turnAttention = { trigger, idleMs, at };
    deps.broadcast({ type: "session.turn_attention", sessionId: record.id, trigger, idleMs, at, message });
    deps.broadcastSessionState(record);
    deps.notifyTurnAttention(record, message);
  }

  function resolveTurnAttention(record: WatchdogSession, action: "stop" | "continue"): void {
    const attention = record.turnAttention;
    if (!attention) return;
    if (action === "stop") {
      recoverStuckTurn(record, turnStallMessage(attention.idleMs, attention.trigger), attention);
      // recoverStuckTurn clears the field, but it intentionally emits failure
      // frames rather than the ordinary resolved frame. Emit this one too so a
      // client can deterministically remove its card before those frames arrive.
      deps.broadcast({ type: "session.turn_attention.resolved", sessionId: record.id });
      deps.broadcastSessionState(record);
      return;
    }
    const at = now();
    record.lastProgressAt = at;
    record.lastStructuralProgressAt = at;
    clearTurnAttention(record);
  }

  function clearTurnAttentionOnProgress(record: WatchdogSession, structural: boolean): void {
    const attention = record.turnAttention;
    if (!attention) return;
    // Silence means any activity disproves the warning. A wedged tool can keep
    // producing raw output forever, so only structural progress dismisses it.
    if (attention.trigger === "wedged" && !structural) return;
    clearTurnAttention(record);
  }

  /** Periodic sweep: dead subprocesses are always recovered. Time-based soft
   *  stalls normally ask the user instead; operators can opt into the legacy
   *  automatic recovery with stallAction="recover". */
  function sweepStalledTurns(): void {
    if (turnStallMs <= 0 && turnActivityStallMs <= 0) return;
    const at = now();
    for (const record of new Set(deps.listSessions())) {
      const trigger = stallTriggerFor(record, at);
      if (!trigger) continue;
      const idleMs = stallIdleMs(record, trigger, at);
      if (trigger === "pid_dead" || deps.stallAction === "recover") {
        recoverStuckTurn(record, turnStallMessage(idleMs, trigger), { trigger, idleMs });
      } else {
        flagTurnForReview(record, trigger, idleMs, at);
      }
    }
  }

  /**
   * Before dispatching a user prompt, recover the session first if its current
   * turn is stalled. Without this a message sent to a hung session is silently
   * turned into a *steer* into the dead turn (promptOptionsFor, which steers while
   * isStreaming) and vanishes — the exact "I typed and nothing happened, it's
   * un-resumable" symptom. Recovering first means the prompt runs as a fresh turn.
   */
  async function recoverStalledBeforePrompt(record: WatchdogSession): Promise<void> {
    const at = now();
    const trigger = stallTriggerFor(record, at);
    if (!trigger) return;
    const idleMs = stallIdleMs(record, trigger, at);
    recoverStuckTurn(record, turnStallMessage(idleMs, trigger), { trigger, idleMs });
    await record.abortRecovery?.catch(() => {});
  }

  async function promptWithWatchdog(record: WatchdogSession, prompt: string, options?: unknown): Promise<void> {
    armTurnWatchdog(record);
    const timeoutSignal = record.turnTimeoutSignal;
    const promptPromise = record.session.prompt(prompt, options);
    // When the watchdog wins the race below, this prompt promise is abandoned but
    // can still reject later — a wedged agent's `chat.send` times out, or its child
    // is killed mid-turn. Mark it handled so that late rejection doesn't surface as
    // an unhandledRejection after the turn has already been recovered. Promise.race
    // still observes the same rejection through the original reference.
    promptPromise.catch(() => {});
    try {
      await Promise.race([
        promptPromise,
        ...(timeoutSignal ? [timeoutSignal.then(() => { throw new Error(turnTimeoutMessage()); })] : []),
      ]);
    } catch (error) {
      // The timeout callback already cleared/persisted the session. For an ordinary
      // prompt failure, disarm here and let the caller publish its actionable error.
      if (!record.turnTimedOut) clearTurnWatchdog(record);
      throw error;
    }
  }

  return {
    armTurnWatchdog,
    clearTurnWatchdog,
    promptWithWatchdog,
    recoverStuckTurn,
    recoverStalledBeforePrompt,
    stallTriggerFor,
    sweepStalledTurns,
    turnRecoveryStats,
    resolveTurnAttention,
    clearTurnAttentionOnProgress,
  };
}
