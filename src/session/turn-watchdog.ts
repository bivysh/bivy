// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** One hour keeps legitimate deep coding turns viable while bounding the
 * default failure/cost window. Automations may choose a lower timeout. */
export const DEFAULT_TURN_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_TURN_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Parse BIVY_TURN_TIMEOUT_MS. Explicit 0 is the documented trusted-workflow
 * escape hatch; malformed/negative values fall back safely instead of silently
 * disabling the watchdog. Very large values are capped to one day. */
export function configuredTurnTimeoutMs(value = process.env.BIVY_TURN_TIMEOUT_MS): number {
  if (value === undefined || value.trim() === "") return DEFAULT_TURN_TIMEOUT_MS;
  const parsed = Number(value);
  if (parsed === 0) return 0;
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TURN_TIMEOUT_MS;
  return Math.min(MAX_TURN_TIMEOUT_MS, Math.max(1_000, Math.floor(parsed)));
}

/**
 * Idle/stall timeout — the second, finer half of the watchdog.
 *
 * DEFAULT_TURN_TIMEOUT_MS is a wall-clock CAP: it fires an hour after the turn
 * started whether the agent is streaming happily or wedged, so a hung agent
 * (opencode's ACP server stops responding, Pi freezes, a runtime never emits
 * `agent_end`) pins the session "working" and un-resumable for up to an hour.
 * This bound instead measures *silence*: a working turn that emits NO progress
 * event (assistant text, a tool call, a turn boundary) for this long is treated
 * as stalled and force-recovered, so a hang clears in minutes, not an hour.
 *
 * Five minutes is well below the hour cap yet generous enough that a legitimate
 * long-running tool (a slow build/test with no interim output) isn't mistaken
 * for a hang. A session genuinely waiting on the human — a pending approval or
 * question — is never counted as stalled by the caller.
 */
export const DEFAULT_TURN_STALL_MS = 5 * 60 * 1000;
/** Floor so a misconfigured tiny value can't turn the stall check into a
 *  hair-trigger that kills healthy turns between two stream chunks. */
export const MIN_TURN_STALL_MS = 30 * 1000;
/** A turn whose subprocess is already dead but that never emitted `agent_end`
 *  is unambiguously stuck. Recover it after this brief grace — long enough that
 *  a turn genuinely completing (process exits, `agent_end` in flight) settles
 *  itself first, short enough to feel instant. */
export const PID_DEAD_GRACE_MS = 15 * 1000;

/** Parse BIVY_TURN_STALL_MS. Explicit 0 opts out of stall detection (rely on the
 * wall-clock cap alone); malformed/negative values fall back to the default. */
export function configuredTurnStallMs(value = process.env.BIVY_TURN_STALL_MS): number {
  if (value === undefined || value.trim() === "") return DEFAULT_TURN_STALL_MS;
  const parsed = Number(value);
  if (parsed === 0) return 0;
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TURN_STALL_MS;
  return Math.max(MIN_TURN_STALL_MS, Math.floor(parsed));
}

/**
 * Decide whether a working turn should be force-recovered as stalled. Pure, so
 * it unit-tests without real time or a live session.
 *
 *  - `pidAlive === false` (subprocess gone, no `agent_end`) → stuck once past a
 *    short grace, regardless of the idle timer.
 *  - otherwise a turn is stalled when it has emitted no progress for `stallMs`.
 *  - `stallMs <= 0` disables the idle check (the wall-clock cap still applies),
 *    but a provably-dead subprocess is still recovered.
 */
export function isTurnStalled(opts: {
  now: number;
  lastProgressAt: number;
  stallMs: number;
  /** Whether the turn's subprocess is alive; undefined when it can't be probed
   *  (e.g. a remote agent-service session on another host). */
  pidAlive?: boolean;
  pidGraceMs?: number;
}): boolean {
  return classifyStallTrigger(opts) !== null;
}

/**
 * Why a turn was force-recovered — a diagnostic label, not a control input.
 *  - `pid_dead`   — the subprocess exited but never emitted `agent_end`.
 *  - `stalled`    — the turn went silent past the idle/stall window.
 *  - `wall_clock` — the turn hit the absolute wall-clock cap (decided at the
 *                   timer callsite, not here — this classifier only sees the
 *                   idle/pid signals).
 * Exported so the daemon can attribute recoveries per runtime (see
 * docs/session-reliability-plan.md, Phase 1) instead of losing the reason to a
 * log line.
 */
export type StallTrigger = "pid_dead" | "stalled" | "wall_clock";

/**
 * The finer sibling of isTurnStalled: returns *which* condition makes a working
 * turn count as stalled, or null when it still looks healthy. Pure, so it
 * unit-tests without real time or a live session. A provably-dead subprocess
 * (`pidAlive === false`) past the grace wins over the idle timer; otherwise a
 * turn silent for `stallMs` is `stalled`. `stallMs <= 0` disables the idle check
 * (the wall-clock cap still applies elsewhere) but a dead subprocess is still
 * reported.
 */
export function classifyStallTrigger(opts: {
  now: number;
  lastProgressAt: number;
  stallMs: number;
  pidAlive?: boolean;
  pidGraceMs?: number;
}): StallTrigger | null {
  const idle = opts.now - opts.lastProgressAt;
  if (opts.pidAlive === false) return idle >= (opts.pidGraceMs ?? PID_DEAD_GRACE_MS) ? "pid_dead" : null;
  if (opts.stallMs <= 0) return null;
  return idle >= opts.stallMs ? "stalled" : null;
}
