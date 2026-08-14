// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The canonical account-facing Run projection. There is ONE customer Run type
// and ONE derivation; the legacy `AccountAutomationRun` and `GithubQueueItem`
// records are adapted into it rather than projected independently. Everything
// here is a pure, framework-agnostic function over already-sanitized control
// plane metadata — no prompts, transcripts, diffs, file contents, or secrets.

import type { AccountAutomationRun, GithubQueueItem } from "./account.js";
import { deriveRunOutcome, type RunOutcome } from "./outcome.js";

/** Which legacy record backed this projection. Diagnostic-only; never a primary
 *  customer label. */
export type RunProjectionSource = "automation_run" | "queue_item";

/** Raw durable status, kept behind the diagnostic boundary. Customers navigate
 *  by {@link RunLifecycle} and {@link RunOutcome}, not this. */
export type RunStatus = GithubQueueItem["status"];

/** Coarse customer lifecycle: Queued → Running/Waiting → Needs attention or
 *  Finished. Claim/lease/attempt states stay in storage and diagnostics. */
export type RunLifecycle = "queued" | "running" | "waiting" | "needs_attention" | "finished";

export type RunActionKind = "cancel" | "retry" | "inspect_checks" | "review_session" | "reauthenticate";

export interface RunAction {
  kind: RunActionKind;
  /** Customer-facing verb. */
  label: string;
  /** Exact credential target for a re-authentication action. */
  provider?: string;
}

export type RunCheck = NonNullable<GithubQueueItem["checks"]>[number];
export type RunEvent = NonNullable<GithubQueueItem["events"]>[number];

export interface RunSource {
  /** Canonical source/trigger kind (e.g. "github:issue", "schedule", "manual"). */
  kind: string;
  /** Bounded external reference: `repo#issue`, an external id, or a url. */
  reference?: string;
  /** The Automation (definition) that created this Run, when known. */
  automationId?: string;
}

export interface RunReferences {
  branch?: string;
  commit?: string;
  pullRequest?: string;
  checkpoint?: string;
  artifact?: string;
}

export interface RunTimestamps {
  createdAt: string;
  claimedAt?: string;
  startedAt?: string;
  completedAt?: string;
  leaseExpiresAt?: string;
}

export type RunMilestoneStage =
  | "trigger_received" | "trigger_matched" | "queued" | "routed" | "provisioning"
  | "claimed" | "agent_started" | "checks_started" | "checks_completed"
  | "result_delivery" | "notification" | "retry" | "cancel_requested" | "terminal";
export interface RunMilestone {
  stage: RunMilestoneStage;
  at: string;
  summary: string;
  attempt?: number;
  reasonCode?: string;
  evidenceRef?: string;
  status?: RunEvent["status"];
}
export type RunOperationalState = "active" | "parked" | "dead_letter" | "terminal";

/** The requested (not necessarily effective) execution knobs, kept for the Run
 *  detail view. Effective/enforced protection is a Receipt-v1 concern. */
export interface RunRequested {
  approvalMode?: GithubQueueItem["approvalMode"];
  sandbox?: GithubQueueItem["sandbox"];
  runtimeId?: string;
  model?: string;
}

export interface Run {
  id: string;
  /** Diagnostic-only origin: which legacy record and its raw durable status. */
  origin: { projection: RunProjectionSource; status: RunStatus };
  lifecycle: RunLifecycle;
  /** Explicit customer outcome derived from durable evidence — never manufactured
   *  from process exit alone. */
  outcome: RunOutcome;
  /** A retry is another attempt of the SAME customer-visible Run. */
  attempt: number;
  maxAttempts?: number;
  title: string;
  source: RunSource;
  /** The Run's current underlying Session id, when correlated. */
  sessionId?: string;
  /** Executing Machine identity when known. `name` is resolved from the node
   *  inventory by the caller; absence is preserved as unknown, never invented. */
  machine?: { id: string; name?: string };
  timestamps: RunTimestamps;
  durationMs?: number;
  requested: RunRequested;
  checks: RunCheck[];
  /** Bounded evidence events (already content-free in the source records). */
  events: RunEvent[];
  receiptEvidence?: GithubQueueItem["receiptEvidence"];
  references: RunReferences;
  /** Bounded failure summary; present only when the record carries one. */
  failureSummary?: string;
  /** Persisted causal milestones normalized from current and legacy records. */
  timeline: RunMilestone[];
  operationalState: RunOperationalState;
  attemptReason?: string;
  usage?: GithubQueueItem["usage"];
  notification?: GithubQueueItem["notification"];
  operationalReferences: NonNullable<GithubQueueItem["references"]>;
  attention?: GithubQueueItem["attention"];
  /** Recovery and cancellation actions available for the Run's current durable
   *  state. Only genuinely available actions appear — no inert buttons. */
  actions: RunAction[];
  /** Exactly the highest-priority currently valid operator action. */
  nextAction?: RunAction;
}

const MAX_FAILURE_SUMMARY = 240;
const MAX_EVENTS = 200;
const MAX_CHECKS = 50;

/** The intersection of fields the two legacy records expose. Both
 *  {@link GithubQueueItem} and {@link AccountAutomationRun} are structurally
 *  assignable to this, so a single derivation serves both. */
interface RunRecord {
  id: string;
  status: RunStatus;
  title: string;
  source?: string;
  triggerKind?: string;
  definitionId?: string;
  repo?: string;
  issueNumber?: number;
  externalId?: string;
  url?: string;
  attempt?: number;
  maxAttempts?: number;
  createdAt: string;
  claimedAt?: string;
  startedAt?: string;
  completedAt?: string;
  leaseExpiresAt?: string;
  claimedByNodeId?: string;
  runtimeId?: string;
  model?: string;
  routingReason?: string;
  approvalMode?: GithubQueueItem["approvalMode"];
  sandbox?: GithubQueueItem["sandbox"];
  checks?: GithubQueueItem["checks"];
  events?: GithubQueueItem["events"];
  receiptEvidence?: GithubQueueItem["receiptEvidence"];
  usage?: GithubQueueItem["usage"];
  notification?: GithubQueueItem["notification"];
  references?: GithubQueueItem["references"];
  attention?: GithubQueueItem["attention"];
  output?: GithubQueueItem["output"];
  targetSessionId?: string;
}

export interface RunProjectionContext {
  /** Resolve a durable Machine (node) id to a customer-facing name, if known. */
  resolveMachineName?: (machineId: string) => string | undefined;
}

const RUNNING_LIKE: ReadonlySet<RunStatus> = new Set(["pending", "claimed", "running"]);
const FINISHED: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled", "done"]);
/** Durable states from which a Run can still be cancelled (issue #501). */
const CANCELLABLE: ReadonlySet<RunStatus> = new Set(["pending", "claimed", "running", "waiting", "needs_attention"]);
/** Terminal outcomes for which starting another attempt is a real next action. */
const RETRYABLE_OUTCOMES: ReadonlySet<RunOutcome["kind"]> = new Set([
  "checks_failed", "needs_review", "agent_failed", "timed_out",
]);

function lifecycleOf(status: RunStatus): RunLifecycle {
  if (status === "waiting") return "waiting";
  if (status === "needs_attention") return "needs_attention";
  if (RUNNING_LIKE.has(status)) return status === "running" ? "running" : "queued";
  if (FINISHED.has(status)) return "finished";
  return "queued";
}

function referenceOf(record: RunRecord): string | undefined {
  if (record.repo) return `${record.repo}${Number.isInteger(record.issueNumber) ? `#${record.issueNumber}` : ""}`;
  return record.externalId || record.url || undefined;
}

function durationOf(t: RunTimestamps): number | undefined {
  const start = t.startedAt ?? t.claimedAt;
  if (!start || !t.completedAt) return undefined;
  const ms = Date.parse(t.completedAt) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

function authProviderForFailure(runtimeId: string | undefined, failure: string | undefined): string | undefined {
  if (!failure || !/\b401\b|\b403\b|unauthori[sz]ed|authenticat|invalid x-api-key|(missing|no|invalid)[\s\S]*(bearer|api[\s_-]?key|token)/i.test(failure)) return undefined;
  const runtime = String(runtimeId || "").trim().toLowerCase();
  if (runtime.startsWith("codex")) return "openai-codex";
  if (runtime.startsWith("claude")) return "anthropic";
  return undefined;
}

const MILESTONE_STAGE = new Set<RunMilestoneStage>([
  "trigger_received", "trigger_matched", "queued", "routed", "provisioning", "claimed",
  "agent_started", "checks_started", "checks_completed", "result_delivery", "notification",
  "retry", "cancel_requested", "terminal",
]);
const LEGACY_STAGE: Partial<Record<RunEvent["kind"], RunMilestoneStage>> = {
  triggered: "trigger_received", attempt_started: "agent_started", completed: "terminal", cancelled: "terminal",
};

function timelineFor(record: RunRecord): RunMilestone[] {
  const timeline = (record.events ?? []).flatMap((event): RunMilestone[] => {
    const stage = MILESTONE_STAGE.has(event.kind as RunMilestoneStage)
      ? event.kind as RunMilestoneStage
      : LEGACY_STAGE[event.kind];
    if (!stage || !event.at) return [];
    return [{ stage, at: event.at, summary: event.summary, attempt: event.attempt, reasonCode: event.reasonCode, evidenceRef: event.evidenceRef, status: event.status }];
  });
  const has = (stage: RunMilestoneStage) => timeline.some((event) => event.stage === stage);
  // Legacy rows get only milestones supported by durable timestamps. Never
  // synthesize a timestamp for an unobserved match/routing/check/delivery stage.
  if (!has("trigger_received") && record.createdAt) timeline.unshift({ stage: "trigger_received", at: record.createdAt, summary: "Run record created." });
  if (!has("claimed") && record.claimedAt) timeline.push({ stage: "claimed", at: record.claimedAt, summary: "Run claimed." });
  if (!has("agent_started") && record.startedAt) timeline.push({ stage: "agent_started", at: record.startedAt, summary: "Agent execution started." });
  if (!has("terminal") && record.completedAt) timeline.push({ stage: "terminal", at: record.completedAt, summary: `Run reached the ${record.status} outcome.` });
  return timeline.slice(-200);
}

function operationalStateOf(record: RunRecord): RunOperationalState {
  if (record.status === "needs_attention" || record.status === "waiting") return "parked";
  if (record.status === "failed") return "dead_letter";
  if (record.status === "succeeded" || record.status === "cancelled" || record.status === "done") return "terminal";
  return "active";
}

function actionsFor(record: RunRecord, outcome: RunOutcome, sessionId: string | undefined): RunAction[] {
  const actions: RunAction[] = [];
  const attempt = Math.max(1, Math.trunc(record.attempt ?? 1));
  const provider = outcome.kind === "agent_failed" ? authProviderForFailure(record.runtimeId, record.output?.failure) : undefined;
  if (outcome.kind === "checks_failed" && record.checks?.some((check) => check.status === "failed")) {
    actions.push({ kind: "inspect_checks", label: "Review failed checks" });
  }
  if (provider) actions.push({ kind: "reauthenticate", label: "Re-authenticate", provider });
  if (outcome.kind === "needs_review" && sessionId) actions.push({ kind: "review_session", label: "Review Session" });
  if (CANCELLABLE.has(record.status)) actions.push({ kind: "cancel", label: "Cancel Run" });
  // Retry is another attempt of a Run that has ENDED in a failure the customer
  // can act on. A still-parked needs_attention Run is cancellable, not retryable.
  if (FINISHED.has(record.status) && RETRYABLE_OUTCOMES.has(outcome.kind) && (!record.maxAttempts || attempt < record.maxAttempts)) actions.push({ kind: "retry", label: "Retry Run" });
  return actions;
}

function projectRun(record: RunRecord, projection: RunProjectionSource, ctx?: RunProjectionContext): Run {
  const outcome = deriveRunOutcome(record);
  const timestamps: RunTimestamps = {
    createdAt: record.createdAt,
    ...(record.claimedAt ? { claimedAt: record.claimedAt } : {}),
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.leaseExpiresAt ? { leaseExpiresAt: record.leaseExpiresAt } : {}),
  };
  const sessionId = record.output?.sessionId || record.targetSessionId || undefined;
  const machineId = record.claimedByNodeId;
  const failure = record.output?.failure;
  const references: RunReferences = {
    ...(record.output?.branch ? { branch: record.output.branch } : {}),
    ...(record.output?.commit ? { commit: record.output.commit } : {}),
    ...(record.output?.prUrl ? { pullRequest: record.output.prUrl } : {}),
    ...(record.output?.checkpoint ? { checkpoint: record.output.checkpoint } : {}),
    ...(record.output?.artifactUrl ? { artifact: record.output.artifactUrl } : {}),
  };
  const actions = actionsFor(record, outcome, sessionId);
  const timeline = timelineFor(record);
  const attemptReason = [...(record.events ?? [])].reverse().find((event) => event.kind === "fallback" || event.kind === "retry")?.summary
    ?? record.routingReason;
  return {
    id: record.id,
    origin: { projection, status: record.status },
    lifecycle: lifecycleOf(record.status),
    outcome,
    attempt: Math.max(1, Math.trunc(record.attempt ?? 1)),
    ...(record.maxAttempts ? { maxAttempts: record.maxAttempts } : {}),
    title: record.title,
    source: {
      kind: record.source || record.triggerKind || "manual",
      ...(referenceOf(record) ? { reference: referenceOf(record) } : {}),
      ...(record.definitionId ? { automationId: record.definitionId } : {}),
    },
    ...(sessionId ? { sessionId } : {}),
    ...(machineId
      ? { machine: { id: machineId, ...(ctx?.resolveMachineName?.(machineId) ? { name: ctx.resolveMachineName(machineId) } : {}) } }
      : {}),
    timestamps,
    ...(durationOf(timestamps) !== undefined ? { durationMs: durationOf(timestamps) } : {}),
    requested: {
      ...(record.approvalMode ? { approvalMode: record.approvalMode } : {}),
      ...(record.sandbox ? { sandbox: record.sandbox } : {}),
      ...(record.runtimeId ? { runtimeId: record.runtimeId } : {}),
      ...(record.model ? { model: record.model } : {}),
    },
    checks: (record.checks ?? []).slice(0, MAX_CHECKS),
    events: (record.events ?? []).slice(-MAX_EVENTS),
    ...(record.receiptEvidence ? { receiptEvidence: record.receiptEvidence } : {}),
    references,
    ...(failure ? { failureSummary: failure.slice(0, MAX_FAILURE_SUMMARY) } : {}),
    timeline,
    operationalState: operationalStateOf(record),
    ...(attemptReason ? { attemptReason } : {}),
    ...(record.usage ? { usage: record.usage } : {}),
    ...(record.notification ? { notification: record.notification } : {}),
    operationalReferences: (record.references ?? []).slice(-20),
    ...(record.attention ? { attention: record.attention } : {}),
    actions,
    ...(actions[0] ? { nextAction: actions[0] } : {}),
  };
}

/** Adapt a legacy GitHub/queue work item into the canonical Run. */
export function runFromQueueItem(item: GithubQueueItem, ctx?: RunProjectionContext): Run {
  return projectRun(item, "queue_item", ctx);
}

/** Adapt a control-plane automation Run record into the canonical Run. */
export function runFromAutomationRun(run: AccountAutomationRun, ctx?: RunProjectionContext): Run {
  return projectRun(run, "automation_run", ctx);
}

/** Stable, copy-pasteable route for a Run detail screen. */
export function runRoutePath(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}`;
}

/** Parse a Run detail path back to its Run id, or null when it is not one.
 *  Tolerant of a leading origin, query, and hash so a pasted URL restores. */
export function parseRunRoute(pathnameOrUrl: string): string | null {
  let path = String(pathnameOrUrl || "").trim();
  if (!path) return null;
  try {
    path = new URL(path).pathname;
  } catch {
    // Not an absolute URL; strip any query/hash from a bare path. Plain indexOf
    // slicing (no regex) so a pasted value can't drive backtracking.
    const cut = Math.min(
      ...["?", "#"].map((c) => path.indexOf(c)).filter((i) => i >= 0),
      path.length,
    );
    path = path.slice(0, cut);
  }
  const match = /^\/runs\/([^/]+)\/?$/.exec(path);
  if (!match || !match[1]) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return id ? id : null;
  } catch {
    return null;
  }
}
