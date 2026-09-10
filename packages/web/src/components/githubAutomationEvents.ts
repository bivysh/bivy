// SPDX-License-Identifier: AGPL-3.0-only
import type { AccountAutomation } from "@bivy/core";

export type GithubEventToggles = {
  issuesLabeled: boolean;
  issueMention: boolean;
  prLabeled: boolean;
  prMention: boolean;
  workflowFailed: boolean;
};

export function togglesFromAutomation(item: Pick<AccountAutomation, "trigger" | "on">): GithubEventToggles {
  if (item.trigger === "github_ci") {
    return { issuesLabeled: false, issueMention: false, prLabeled: false, prMention: false, workflowFailed: true };
  }
  const on = item.on;
  if (!on?.length) {
    return { issuesLabeled: true, issueMention: true, prLabeled: false, prMention: false, workflowFailed: false };
  }
  return {
    issuesLabeled: on.some((r) => r.event === "issues" && !r.mention),
    issueMention: on.some((r) => ["issues", "pull_request", "issue_comment"].includes(r.event) && r.mention),
    prLabeled: on.some((r) => r.event === "pull_request" && !r.mention),
    prMention: on.some((r) => r.event === "pull_request_review_comment" && r.mention),
    workflowFailed: on.some((r) => r.event === "workflow_run"),
  };
}

export function buildGithubOn(
  toggles: GithubEventToggles,
  labelList: string[] | undefined,
  workflowList: string[] | undefined,
): NonNullable<AccountAutomation["on"]> {
  const labels = labelList?.length ? labelList : ["bivy"];
  const on: NonNullable<AccountAutomation["on"]> = [];
  if (toggles.issuesLabeled) on.push({ event: "issues", labels });
  // Bodies and conversation comments are different GitHub webhook families.
  // Keep mention rules separate from labels: a mention needs no label.
  if (toggles.issueMention) {
    on.push(
      { event: "issues", mention: true },
      { event: "pull_request", mention: true },
      { event: "issue_comment", mention: true },
    );
  }
  if (toggles.prLabeled) on.push({ event: "pull_request", labels });
  if (toggles.prMention) on.push({ event: "pull_request_review_comment", mention: true });
  if (toggles.workflowFailed) {
    on.push({
      event: "workflow_run",
      actions: ["completed"],
      conclusions: ["failure", "timed_out", "startup_failure"],
      workflows: workflowList?.length ? workflowList : undefined,
    });
  }
  return on;
}
