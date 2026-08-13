// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Overlap/shadow detection for first-match automation lists. Because the
// FIRST enabled match wins (match.ts), an earlier automation whose scope is a
// superset of a later one makes the later one unreachable ("shadowed") —
// silently, since intake never reports it. This module surfaces that, plus
// weaker "overlaps" (both could fire for some event, but neither dominates).
//
// Scope: only github/linear source triggers go through matchFirst at all —
// schedule/webhook/manual automations each own their intake (cron occurrence,
// signed URL, direct id) with no first-match ambiguity, so they're excluded.
import { effectiveEventRules, labelsMatch, repoAllowed } from "./match.js";
import type { EvaluableAutomation, EvaluableEventRule, OverlapFinding } from "./types.js";

function listCovers(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a?.length) return true; // wildcard covers anything
  if (!b?.length) return false; // b accepts "any"; a does not
  const wantA = new Set(a.map((v) => v.trim().toLowerCase()));
  return b.every((v) => wantA.has(v.trim().toLowerCase()));
}

function reposCover(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a?.length) return true;
  if (!b?.length) return false;
  return b.every((repo) => repoAllowed(a, repo));
}

function reposIntersect(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a?.length || !b?.length) return true; // either side is "all repos"
  const wantA = new Set(a.map((v) => v.trim().toLowerCase()));
  return b.some((repo) => wantA.has(repo.trim().toLowerCase()));
}

/** Whether every event `ruleB` would match is also matched by `ruleA`. */
function ruleCovers(ruleA: EvaluableEventRule, ruleB: EvaluableEventRule): boolean {
  if (ruleA.event !== ruleB.event) return false;
  if (!listCovers(ruleA.actions, ruleB.actions)) return false;
  if (Boolean(ruleA.mention) !== Boolean(ruleB.mention)) return false; // different match mode
  if (ruleA.event === "workflow_run") {
    const aConclusions = ruleA.conclusions?.length ? ruleA.conclusions : ["failure", "timed_out", "startup_failure"];
    const bConclusions = ruleB.conclusions?.length ? ruleB.conclusions : ["failure", "timed_out", "startup_failure"];
    return listCovers(aConclusions, bConclusions) && listCovers(ruleA.workflows, ruleB.workflows);
  }
  const aLabels = ruleA.labels?.length ? ruleA.labels : ruleA.mention ? undefined : ["bivy"];
  const bLabels = ruleB.labels?.length ? ruleB.labels : ruleB.mention ? undefined : ["bivy"];
  if (ruleA.mention) return !aLabels || listCovers(aLabels, bLabels);
  return listCovers(aLabels, bLabels);
}

function rulesIntersect(ruleA: EvaluableEventRule, ruleB: EvaluableEventRule): boolean {
  if (ruleA.event !== ruleB.event) return false;
  if (Boolean(ruleA.mention) !== Boolean(ruleB.mention)) return false;
  return true; // same event + same mode is enough for a soft "could overlap" signal
}

/**
 * Whether `before` fully shadows `after`: every event `after` would accept is
 * also accepted by `before`. Both must already be filtered to the same
 * trigger kind and be enabled.
 */
function automationCovers(before: EvaluableAutomation, after: EvaluableAutomation): boolean {
  const beforeRepos = before.repos?.length ? before.repos : before.repo ? [before.repo] : undefined;
  const afterRepos = after.repos?.length ? after.repos : after.repo ? [after.repo] : undefined;
  if (!reposCover(beforeRepos, afterRepos)) return false;

  if (before.trigger === "linear") {
    return listCovers(before.labels?.length ? before.labels : ["bivy"], after.labels?.length ? after.labels : ["bivy"]);
  }

  const beforeRules = effectiveEventRules(before);
  const afterRules = effectiveEventRules(after);
  if (afterRules.length === 0) return false;
  return afterRules.every((ruleB) => beforeRules.some((ruleA) => ruleCovers(ruleA, ruleB)));
}

function automationsIntersect(a: EvaluableAutomation, b: EvaluableAutomation): boolean {
  const aRepos = a.repos?.length ? a.repos : a.repo ? [a.repo] : undefined;
  const bRepos = b.repos?.length ? b.repos : b.repo ? [b.repo] : undefined;
  if (!reposIntersect(aRepos, bRepos)) return false;

  if (a.trigger === "linear") return true; // repo intersection is the only scoping signal today

  const aRules = effectiveEventRules(a);
  const bRules = effectiveEventRules(b);
  return aRules.some((ruleA) => bRules.some((ruleB) => rulesIntersect(ruleA, ruleB)));
}

/**
 * Find overlapping/shadowed pairs among enabled github/linear automations, in
 * the order they'll be evaluated by matchFirst. Returns at most one finding
 * per (before, after) pair — a "shadowed" finding implies overlap, so it is
 * not also reported as "overlaps".
 */
export function findOverlaps(automations: EvaluableAutomation[]): OverlapFinding[] {
  const findings: OverlapFinding[] = [];
  const candidates = automations.filter((a) => a.enabled && (a.trigger === "github" || a.trigger === "linear"));
  for (let i = 0; i < candidates.length; i += 1) {
    const before = candidates[i]!;
    for (let j = i + 1; j < candidates.length; j += 1) {
      const after = candidates[j]!;
      if (before.trigger !== after.trigger) continue;
      if (automationCovers(before, after)) {
        findings.push({
          kind: "shadowed",
          beforeId: before.id,
          afterId: after.id,
          detail: `${after.id} can never fire: every event it accepts is already matched by the earlier automation ${before.id}`,
        });
        continue;
      }
      if (automationsIntersect(before, after)) {
        findings.push({
          kind: "overlaps",
          beforeId: before.id,
          afterId: after.id,
          detail: `${before.id} and ${after.id} both accept some of the same events; ${before.id} wins ties since it is evaluated first`,
        });
      }
    }
  }
  return findings;
}
