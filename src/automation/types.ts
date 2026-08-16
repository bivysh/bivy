// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Canonical types for the shared automation preflight/simulation evaluator.
// This module is consumed directly (relative import) by the root CLI package
// and, via the packages/automation-core wrapper, by services/control-plane.
// See packages/automation-core/README for why a wrapper package exists instead
// of a direct workspace dependency: the root node/CLI deliberately does not
// depend on packages/* (see src/session/inline-image-fetch.ts's note on
// @bivy/core), so the canonical source lives here and is re-published for
// packages that DO use npm-installed dependencies (control-plane, web).

export type EvaluationTriggerKind = "github" | "linear" | "schedule" | "webhook" | "manual";

export type GithubEventName =
  | "issues"
  | "issue_comment"
  | "pull_request"
  | "pull_request_review_comment"
  | "workflow_run";

/** One "when" clause on a GitHub automation. Any matching rule fires the job. */
export interface EvaluableEventRule {
  event: GithubEventName;
  /** Optional action allowlist (e.g. labeled, opened, completed). Empty/undefined = any. */
  actions?: string[];
  /** Label filter. Empty/undefined with no mention → default `bivy` / `bivy/<node>`. */
  labels?: string[];
  /** Require an @-mention of the app handle in body/comment text. */
  mention?: boolean;
  /** workflow_run: conclusion allowlist. Default when omitted: failure (+ cancelled family). */
  conclusions?: string[];
  /** workflow_run: workflow name allowlist. Empty/undefined = any workflow. */
  workflows?: string[];
}

/** Minimal automation shape the matcher/overlap detector need. Callers adapt
 *  their own richer type (AutomationConfigEntry, AutomationDefinition, ...)
 *  into this shape at the boundary rather than the evaluator depending on
 *  any one package's storage model. */
export interface EvaluableAutomation {
  id: string;
  enabled: boolean;
  trigger: EvaluationTriggerKind;
  repo?: string;
  repos?: string[];
  labels?: string[];
  on?: EvaluableEventRule[];
}

/** Normalized event fixture. Field names match the documented `bivy automation
 *  test` fixture format (docs/automations-as-code.md) since that is the
 *  user-facing vocabulary; other callers adapt their own event shape at the
 *  boundary (see services/control-plane/src/automation-match.ts). */
export interface EvaluationEvent {
  kind: EvaluationTriggerKind;
  repo?: string;
  labels?: string[];
  mention?: boolean;
  event?: GithubEventName;
  action?: string;
  conclusion?: string;
  workflow?: string;
}

/** Per-candidate explanation, in evaluation order. Powers "explain each rule
 *  acceptance/rejection" for config-as-code `test`, the control-plane
 *  simulate endpoint, and the PWA Test event workflow. */
export interface MatchTrailEntry {
  id: string;
  matched: boolean;
  reason: string;
}

export interface MatchResult<T extends EvaluableAutomation = EvaluableAutomation> {
  matched?: T;
  trail: MatchTrailEntry[];
}

export type OverlapKind = "shadowed" | "overlaps";

/** A pair where `before` (evaluated first, per first-match order) either fully
 *  shadows `after` (after can never fire — `kind: "shadowed"`) or merely
 *  intersects it (some events would match both — `kind: "overlaps"`). */
export interface OverlapFinding {
  kind: OverlapKind;
  beforeId: string;
  afterId: string;
  detail: string;
}

export const PREFLIGHT_CHECK_IDS = [
  "source_connection",
  "repo_access",
  "encrypted_key_ownership",
  "assigned_machine",
  "agent_model_credentials",
  "sandbox_policy",
] as const;

export type PreflightCheckId = (typeof PREFLIGHT_CHECK_IDS)[number];

export type PreflightSeverity = "ok" | "info" | "warn" | "block" | "skipped";

export interface PreflightCheckResult {
  id: PreflightCheckId;
  severity: PreflightSeverity;
  label: string;
  detail: string;
  /** True only for a condition that must stop save. */
  blocksSave: boolean;
}

/**
 * Input signals for the preflight checklist. Every field is optional: the
 * evaluator does NO I/O itself, so a caller only fills in what it can
 * observe in its own environment (the CLI reads local files; control-plane
 * queries its store). An absent field reports "skipped" rather than being
 * silently treated as passing.
 */
export interface PreflightSignals {
  sourceConnection?: {
    /** Whether this automation's trigger needs a connected source at all
     *  (schedule/webhook/manual do not). */
    required: boolean;
    connected: boolean;
    detail?: string;
  };
  repoAccess?: {
    required: boolean;
    configuredRepos: string[];
    /** Whether the source is known to be installed on at least one of the
     *  configured repos. Undefined = unknown (e.g. no network). */
    knownInstalled?: boolean;
    detail?: string;
  };
  encryptedKeyOwnership?: {
    /** Whether this automation trigger fires a run at all (manual test-only
     *  drafts may skip this). */
    required: boolean;
    hasCiphertext: boolean;
    ownerNodeOnline?: boolean;
    detail?: string;
  };
  assignedMachine?: {
    nodeLabel?: string;
    primaryOnline?: boolean;
    hasFallback?: boolean;
    fallbackAvailable?: boolean;
    /** For the shared `bivy` queue: any online node at all. */
    sharedQueueHasOnlineNode?: boolean;
    /** Required capability tags (if any) that NO known machine — online or
     *  offline — has ever declared. Computed by the caller (which has access
     *  to node records) using @bivy/core's anyNodeEligible; preflight.ts stays
     *  dependency-free and only reads this plain result. Takes priority over
     *  primaryOnline: a machine can be online yet still lack a required tag,
     *  and reporting that honestly is the whole point of this signal. */
    capabilityGap?: string[];
    detail?: string;
  };
  agentModelCredentials?: {
    agent?: string;
    model?: string;
    /** true = known ready, false = known NOT ready, undefined = unknown. */
    ready?: boolean;
    /** Whether the agent/model was explicitly requested (vs left to node
     *  defaults, which can't be checked ahead of a run). */
    explicit: boolean;
    detail?: string;
  };
  sandboxPolicy?: {
    requestedApproval: string;
    requestedSandbox: string;
    effectiveApproval: string;
    effectiveSandbox: string;
    /** autonomous + danger-full-access without an explicit acknowledgement. */
    unsafeCombo: boolean;
    detail?: string;
  };
}

export interface PreflightGate {
  blocked: boolean;
  blockingChecks: PreflightCheckResult[];
  requiresAck: boolean;
  warnChecks: PreflightCheckResult[];
}

export interface AutomationEvaluation<T extends EvaluableAutomation = EvaluableAutomation> {
  match?: MatchResult<T>;
  overlaps: OverlapFinding[];
  preflight: PreflightCheckResult[];
  gate: PreflightGate;
}
