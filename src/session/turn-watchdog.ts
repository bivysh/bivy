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
