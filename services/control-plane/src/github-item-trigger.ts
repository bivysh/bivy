// SPDX-License-Identifier: MIT
import type { AutomationDefinition, InboundHook } from "./store.js";
import { matchSourceAutomation } from "./automation-match.js";
import {
  meetsTriggerAccess, parseGithubIssueEvent, parseGithubPullRequestEvent,
  pickIssueRoutingLabel, pickRoutingLabel, type ParsedIssueWork,
} from "./webhooks.js";

type ItemMatch =
  | { matched: false; reason: "unsupported_event" | "no_automation" | "access" }
  | { matched: true; item: ParsedIssueWork; automation: AutomationDefinition; routingLabel: string };

/** Automation rules decide whether a delivery triggers work. Routing labels
 * only decide where that work goes; custom trigger labels need no bivy prefix. */
export function matchGithubItemTrigger(
  definitions: AutomationDefinition[],
  hook: Pick<InboundHook, "appId" | "triggerAccess">,
  event: "issues" | "pull_request",
  payload: unknown,
  triggerLogin: string,
): ItemMatch {
  const item = event === "issues" ? parseGithubIssueEvent(payload) : parseGithubPullRequestEvent(payload);
  if (!item) return { matched: false, reason: "unsupported_event" };
  const delivery = payload as { action?: unknown; label?: { name?: unknown }; sender?: { login?: unknown } };
  const action = String(delivery.action ?? "");
  // GitHub includes the newly applied label separately. Adding an unrelated
  // label must not re-fire an automation just because its label was already there.
  const labels = action === "labeled" && typeof delivery.label?.name === "string"
    ? [delivery.label.name] : item.labels;
  // A label delivery does not introduce a new body mention. Reusing the
  // existing body here makes unrelated/status label additions re-trigger work.
  const mentionRoute = action === "labeled" ? undefined : pickIssueRoutingLabel({ ...item, labels: [] }, triggerLogin);
  const authorAllowed = meetsTriggerAccess(item.authorAssociation, hook.triggerAccess);
  // A label stands for whoever applied it, which needs triage access. Any other
  // action on a labelled item (an edit, a push) and a label the author applied
  // themselves (an issue form's default labels) is the author's, so it needs the
  // same access as a mention.
  const sender = typeof delivery.sender?.login === "string" ? delivery.sender.login.toLowerCase() : "";
  const appliedByAuthor = Boolean(sender) && sender === item.authorLogin?.toLowerCase();
  const labelsAllowed = authorAllowed || (action === "labeled" && !appliedByAuthor);
  const match = (withLabels: string[]) => matchSourceAutomation(definitions, {
    kind: "github", appId: hook.appId, githubEvent: event, action,
    repo: item.repo, labels: withLabels, mention: Boolean(mentionRoute) && authorAllowed,
  });
  const automation = match(labelsAllowed ? labels : []);
  if (!automation) {
    const denied = (mentionRoute && !authorAllowed) || (!labelsAllowed && labels.length > 0 && Boolean(match(labels)));
    return { matched: false, reason: denied ? "access" : "no_automation" };
  }
  return {
    matched: true, item, automation,
    // Keep legacy machine routing, without treating a custom trigger label as
    // a queue or machine name. An automation's nodeLabel takes precedence upstream.
    routingLabel: pickRoutingLabel(item.labels) ?? (authorAllowed ? mentionRoute : undefined) ?? "bivy",
  };
}
