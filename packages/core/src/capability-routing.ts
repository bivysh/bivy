// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Capability tags are manually declared assertions by a Machine's owner (e.g.
 * "gpu", "docker", "private-net") — never auto-detected or verified. A tag
 * being present means the owner asserted it; it is not re-checked, and a
 * Machine that has gone offline since asserting a tag keeps asserting it (the
 * assertion just can't currently be acted on). This module is a pure,
 * dependency-free matcher shared by the control plane, the node CLI, and the
 * repository environment manifest — it holds no I/O, no store, no network.
 */

export const CAPABILITY_TAG_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const MAX_CAPABILITY_TAGS = 32;

export interface CapabilityTagsResult {
  ok: boolean;
  tags: string[];
  errors: string[];
}

/** Validate a raw value as a bounded set of lowercase-slug capability tags.
 * Never throws. Duplicate tags collapse to one; order is not significant. */
export function validateCapabilityTags(value: unknown, at = "capabilities"): CapabilityTagsResult {
  const errors: string[] = [];
  if (value === undefined) return { ok: true, tags: [], errors };
  if (!Array.isArray(value)) return { ok: false, tags: [], errors: [`${at} must be a list of strings`] };
  if (value.length > MAX_CAPABILITY_TAGS) errors.push(`${at} may contain at most ${MAX_CAPABILITY_TAGS} tags`);
  const tags: string[] = [];
  for (const raw of value.slice(0, MAX_CAPABILITY_TAGS + 1)) {
    if (typeof raw !== "string" || !CAPABILITY_TAG_RE.test(raw)) {
      errors.push(`${at} entries must be lowercase slugs (letters, digits, '-'; up to 64 characters), got ${JSON.stringify(raw)}`);
      continue;
    }
    if (!tags.includes(raw)) tags.push(raw);
  }
  return { ok: errors.length === 0, tags: errors.length ? [] : tags, errors };
}

export interface CapabilityMatch {
  /** False when at least one required tag is missing — a hard block. */
  eligible: boolean;
  missingRequired: string[];
  matchedPreferred: string[];
  unmatchedPreferred: string[];
  /** Count of matched preferred tags; 0 when there are none requested. Never
   * used to decide eligibility — preferences rank, they do not gate. */
  score: number;
}

/** Compare a Machine's self-declared capability tags against a request's
 * required/preferred tags. Pure and deterministic: same inputs, same output. */
export function matchCapabilities(
  nodeCapabilities: string[] | undefined,
  required: string[] | undefined,
  preferred: string[] | undefined,
): CapabilityMatch {
  const have = new Set(nodeCapabilities ?? []);
  const req = required ?? [];
  const pref = preferred ?? [];
  const missingRequired = req.filter((tag) => !have.has(tag));
  const matchedPreferred = pref.filter((tag) => have.has(tag));
  const unmatchedPreferred = pref.filter((tag) => !have.has(tag));
  return {
    eligible: missingRequired.length === 0,
    missingRequired,
    matchedPreferred,
    unmatchedPreferred,
    score: matchedPreferred.length,
  };
}

/** True only when at least one node in the account has ever asserted every
 * required tag — online or offline, since offline just means "not currently
 * reachable," not "ineligible" (a stale/offline assertion is still honest
 * evidence a matching Machine exists). Used to decide whether a request with
 * required tags should honestly park (`needs_attention`) instead of queuing
 * forever for a capability nothing has ever claimed to have. */
export function anyNodeEligible(nodeCapabilities: Array<string[] | undefined>, required: string[] | undefined): boolean {
  if (!required || required.length === 0) return true;
  return nodeCapabilities.some((caps) => matchCapabilities(caps, required, undefined).eligible);
}

const EXPLANATION_MAX = 200;

/** Bounded, privacy-safe explanation of a capability match: only tag names,
 * never endpoint URLs, command text, node identity beyond a caller-supplied
 * safe label, or any other secret/private material. Trims to fit the same
 * 200-character routingReason budget the rest of the routing system uses. */
export function explainCapabilityMatch(match: CapabilityMatch, opts?: { label?: string }): string {
  const parts: string[] = [];
  const label = opts?.label?.trim();
  if (!match.eligible) {
    parts.push(`missing required capability: ${match.missingRequired.join(", ")}`);
  } else {
    if (label) parts.push(`routed to ${label}`);
    if (match.matchedPreferred.length) parts.push(`matched preferred: ${match.matchedPreferred.join(", ")}`);
    if (match.unmatchedPreferred.length) parts.push(`preferred unavailable: ${match.unmatchedPreferred.join(", ")}`);
  }
  const text = parts.join("; ") || (match.eligible ? "eligible" : "not eligible");
  return text.length > EXPLANATION_MAX ? `${text.slice(0, EXPLANATION_MAX - 1)}…` : text;
}

/**
 * Soft, best-effort claim delay in milliseconds for a preferred-capability
 * request. A node that matches fewer of the requested preferred tags waits
 * slightly longer before attempting to claim a pending item, giving a
 * better-matching Machine (with a shorter or zero delay) first opportunity to
 * claim it. Any node — including a zero-match one — can still claim it once
 * the delay elapses, so this never fabricates availability: it only nudges
 * who tends to win the race when more than one online Machine is eligible.
 * Pure and deterministic (no randomness) so it stays unit-testable; the
 * control plane has no push/scheduling channel to do this centrally (see
 * docs on the pull-based work queue), so the preference signal is expressed
 * as node-side jitter instead of server-side ranking.
 */
export function capabilityClaimDelayMs(match: CapabilityMatch, opts?: { baseMs?: number; maxMs?: number }): number {
  if (!match.eligible) return 0;
  const wanted = match.matchedPreferred.length + match.unmatchedPreferred.length;
  if (wanted === 0) return 0;
  const baseMs = opts?.baseMs ?? 1500;
  const maxMs = opts?.maxMs ?? 4000;
  const ratio = match.unmatchedPreferred.length / wanted;
  return Math.min(maxMs, Math.round(baseMs * ratio));
}
