// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

import { deriveRunOutcome, type GithubQueueItem, type RunOutcome } from "@bivy/core";

type Check = NonNullable<GithubQueueItem["checks"]>[number];
type Event = NonNullable<GithubQueueItem["events"]>[number];

/** Structural input shared by the account automation-run API and its legacy
 * work-item compatibility projection. Keeping this structural avoids creating a
 * second Run record in the PWA. */
export interface RunDetailInput {
  status: "pending" | "claimed" | "running" | "waiting" | "needs_attention" | "succeeded" | "failed" | "cancelled" | "done";
  attempt?: number;
  runtimeId?: string;
  model?: string;
  routingReason?: string;
  checks?: Check[];
  events?: Event[];
  output?: {
    sessionId?: string;
    branch?: string;
    commit?: string;
    checkpoint?: string;
    prUrl?: string;
    artifactUrl?: string;
    failure?: string;
  };
}

const TERMINAL_RUN_STATUSES = new Set<RunDetailInput["status"]>(["succeeded", "failed", "cancelled", "done"]);

/** Cancellation is only meaningful while the durable Run record is nonterminal. */
export function isTerminalRun(run: Pick<RunDetailInput, "status">): boolean {
  return TERMINAL_RUN_STATUSES.has(run.status);
}

export interface RunDetailProjection {
  outcome: RunOutcome;
  sessionId?: string;
  attempt: number;
  agent?: string;
  failure?: string;
  checks: Check[];
  checksSummary?: string;
  artifact?: { kind: "pull_request" | "artifact" | "branch" | "commit" | "checkpoint"; label: string; url?: string };
  /** Actions for which the projection has enough durable references. */
  availableActions: Array<"open_session" | "view_pull_request" | "view_artifact">;
}

/** One conservative customer projection for every Run surface. Process exit or
 * a `succeeded` lifecycle state without artifact/check/no-change evidence stays
 * Needs review through deriveRunOutcome. */
export function projectRunDetail(run: RunDetailInput): RunDetailProjection {
  const outcome = deriveRunOutcome(run);
  const checks = run.checks ?? [];
  const passed = checks.filter((check) => check.status === "passed").length;
  const failed = checks.filter((check) => check.status === "failed").length;
  const skipped = checks.filter((check) => check.status === "skipped").length;
  const checksSummary = checks.length
    ? [passed ? `${passed} passed` : "", failed ? `${failed} failed` : "", skipped ? `${skipped} skipped` : ""].filter(Boolean).join(" · ")
    : undefined;

  const output = run.output;
  const artifact = output?.prUrl
    ? { kind: "pull_request" as const, label: "Pull request", url: output.prUrl }
    : output?.artifactUrl
      ? { kind: "artifact" as const, label: "Artifact", url: output.artifactUrl }
      : output?.branch
        ? { kind: "branch" as const, label: `Branch ${output.branch}` }
        : output?.commit
          ? { kind: "commit" as const, label: `Commit ${output.commit.slice(0, 12)}` }
          : output?.checkpoint
            ? { kind: "checkpoint" as const, label: "Checkpoint" }
            : undefined;

  const availableActions: RunDetailProjection["availableActions"] = [];
  if (output?.sessionId) availableActions.push("open_session");
  if (output?.prUrl) availableActions.push("view_pull_request");
  else if (output?.artifactUrl) availableActions.push("view_artifact");

  return {
    outcome,
    sessionId: output?.sessionId,
    attempt: Math.max(1, run.attempt ?? 1),
    agent: [run.runtimeId, run.model].filter(Boolean).join(" · ") || undefined,
    failure: output?.failure,
    checks,
    checksSummary,
    artifact,
    availableActions,
  };
}
