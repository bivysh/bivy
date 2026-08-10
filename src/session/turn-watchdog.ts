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
 * Activity/wedged timeout — the third watchdog band, between the 5-minute silence
 * stall and the 1-hour wall-clock cap.
 *
 * DEFAULT_TURN_STALL_MS measures TOTAL silence, so it never fires while a turn is
 * emitting *any* event. But a tool subprocess can be wedged yet chatty — an
 * `npm install` retrying against an unreachable registry, a build looping on a
 * progress bar — streaming `tool_execution_update` output forever without ever
 * completing a tool, advancing the model's text, or crossing a turn boundary.
 * Every one of those output chunks resets the silence anchor, so the 5-minute
 * stall check is defeated and only the hour cap eventually recovers the session.
 *
 * This bound instead measures silence of *structural* progress (a tool
 * start/end, streamed model text, a turn boundary) while ignoring raw subprocess
 * output. Fifteen minutes is comfortably above a legitimately long single tool
 * call that streams output before finishing, yet far below the hour cap, so a
 * chatty-but-wedged turn recovers in minutes. Configured via
 * `sessions.wedgedTurnMinutes` (config.yaml); the env var is a fallback.
 */
export const DEFAULT_TURN_ACTIVITY_STALL_MS = 15 * 60 * 1000;
/** Floor so a misconfigured tiny value can't kill healthy long tool calls that
 *  legitimately stream output for a while before completing. */
export const MIN_TURN_ACTIVITY_STALL_MS = 60 * 1000;

/** Parse the wedged/activity-stall window (ms). Explicit 0 opts out (rely on the
 * silence stall + wall-clock cap); malformed/negative values fall back to the
 * default. Fed from `sessions.wedgedTurnMinutes` in server.ts, env as fallback. */
export function configuredTurnActivityStallMs(value = process.env.BIVY_TURN_ACTIVITY_STALL_MS): number {
  if (value === undefined || value.trim() === "") return DEFAULT_TURN_ACTIVITY_STALL_MS;
  const parsed = Number(value);
  if (parsed === 0) return 0;
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TURN_ACTIVITY_STALL_MS;
  return Math.max(MIN_TURN_ACTIVITY_STALL_MS, Math.floor(parsed));
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
  lastStructuralProgressAt?: number;
  activityStallMs?: number;
}): boolean {
  return classifyStallTrigger(opts) !== null;
}

/**
 * Why a turn was force-recovered — a diagnostic label, not a control input.
 *  - `pid_dead`   — the subprocess exited but never emitted `agent_end`.
 *  - `stalled`    — the turn went silent past the idle/stall window.
 *  - `wedged`     — the turn kept emitting raw subprocess output but made no
 *                   structural progress (no tool completion, model text, or turn
 *                   boundary) past the activity window — a chatty-but-hung tool.
 *  - `wall_clock` — the turn hit the absolute wall-clock cap (decided at the
 *                   timer callsite, not here — this classifier only sees the
 *                   idle/pid signals).
 * Exported so the daemon can attribute recoveries per runtime (see
 * docs/session-reliability-plan.md, Phase 1) instead of losing the reason to a
 * log line.
 */
export type StallTrigger = "pid_dead" | "stalled" | "wedged" | "wall_clock";

/**
 * The finer sibling of isTurnStalled: returns *which* condition makes a working
 * turn count as stalled, or null when it still looks healthy. Pure, so it
 * unit-tests without real time or a live session. Precedence: a provably-dead
 * subprocess (`pidAlive === false`) past the grace wins; then total silence for
 * `stallMs` is `stalled`; then structural silence (raw output still flowing, but
 * no tool/model/turn progress) for `activityStallMs` is `wedged`. Each window is
 * disabled by a value `<= 0` (the wall-clock cap still applies elsewhere), but a
 * dead subprocess is always reported.
 */
export function classifyStallTrigger(opts: {
  now: number;
  lastProgressAt: number;
  stallMs: number;
  pidAlive?: boolean;
  pidGraceMs?: number;
  /** Timestamp of the last *structural* progress (tool start/end, model text,
   *  turn boundary) — unlike lastProgressAt this is NOT bumped by raw subprocess
   *  output. Omit to disable the wedged band. */
  lastStructuralProgressAt?: number;
  activityStallMs?: number;
}): StallTrigger | null {
  const idle = opts.now - opts.lastProgressAt;
  if (opts.pidAlive === false) return idle >= (opts.pidGraceMs ?? PID_DEAD_GRACE_MS) ? "pid_dead" : null;
  if (opts.stallMs > 0 && idle >= opts.stallMs) return "stalled";
  if (opts.activityStallMs && opts.activityStallMs > 0 && opts.lastStructuralProgressAt !== undefined) {
    if (opts.now - opts.lastStructuralProgressAt >= opts.activityStallMs) return "wedged";
  }
  return null;
}
