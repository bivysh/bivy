// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Classify a session's `source` tag into the trigger that started it, so every
// surface that shows a run — the sidebar list, the in-session pill, the GitHub
// queue screen — agrees on one mark and one label instead of re-parsing the
// string each place. The node stores `source` as a compact tag; the shapes we
// see are:
//   repo:owner/name        a workspace session opened by hand (app or CLI)
//   issue:owner/repo#123   a labelled GitHub issue the queue picked up
//   queue:github:issue     a labelled issue with no repo worktree
//   queue:github:comment   an @-mention of the GitHub app
//   queue:slack            a Slack request
//   queue:linear:issue     a labelled Linear issue
//   queue:schedule         a scheduled (cron/one-off) automation
//   queue:webhook          a signed inbound webhook
//   queue:manual           a "Run now" dispatch of an automation definition
//   takeover/import/replica:… housekeeping tags — treated as ordinary sessions
//   (empty)                a plain workspace session
// See src/server.ts (`queue:${item.source}`, `repo:${slug}`, `issue:…`) and
// packages/core/src/store-normalize.ts for where these are produced/parsed.

/** Every trigger a run can carry, plus the two non-automation origins (a live
 *  `bivy run` terminal → `cli`, anything else opened by hand → `app`). */
export type SourceKind =
  | "github-issue"
  | "github-mention"
  | "slack"
  | "linear"
  | "schedule"
  | "webhook"
  | "manual"
  | "cli"
  | "app";

export interface SourceInfo {
  kind: SourceKind;
  /** Full, human-facing label — used as the mark's tooltip and the pill text. */
  label: string;
  /** True for the queue-driven triggers, i.e. runs that carry a live lifecycle
   *  status worth surfacing. `cli`/`app` sessions are just sessions. */
  automation: boolean;
}

/** A `bivy run <agent>` session — the live terminal row (surfaced from the
 *  run-terminal list) and the durable session the node records for it under
 *  `source: "cli"` share this one mark. */
export const CLI_SOURCE: SourceInfo = { kind: "cli", label: "Terminal · bivy run", automation: false };

/** A `bivy run` session whose PTY the node reports as still alive. The node
 *  advertises it as `source: "cli"` + `status: "working"` (no chat record holds
 *  it — see server.ts detachedSessionStatus), so a tap must hand off to the run
 *  terminal (open terminal / continue in chat) rather than resume a second
 *  writer over the live TUI. */
export function isLiveRunSession(s: { source?: string; status?: string }): boolean {
  return (s.source ?? "").trim() === "cli" && s.status === "working";
}

/** Map a session's `source` tag to the trigger that started it. Unknown or
 *  housekeeping tags fall through to a plain `app` session — never throws, so
 *  a new server-side tag degrades to "a session" rather than breaking a row. */
export function classifySource(source: string | undefined): SourceInfo {
  const s = (source ?? "").trim();
  if (s.startsWith("issue:") || s === "queue:github:issue" || s.startsWith("github:issue")) {
    return { kind: "github-issue", label: "GitHub · labelled issue", automation: true };
  }
  if (s === "queue:github:comment" || s === "github:comment") {
    return { kind: "github-mention", label: "GitHub · @-mention", automation: true };
  }
  if (s === "queue:slack" || s === "slack") {
    return { kind: "slack", label: "Slack request", automation: true };
  }
  if (s === "queue:linear:issue" || s === "linear:issue") {
    return { kind: "linear", label: "Linear issue", automation: true };
  }
  if (s === "queue:schedule" || s === "schedule") {
    return { kind: "schedule", label: "Scheduled run", automation: true };
  }
  // A signed webhook — the generic `automation:<hookId>` hook and a
  // webhook-triggered automation definition both carry an `automation:` source
  // (bare, or `queue:automation:` for a non-repo run).
  if (s === "queue:webhook" || s === "webhook" || s.startsWith("automation:") || s.startsWith("queue:automation:")) {
    return { kind: "webhook", label: "Webhook", automation: true };
  }
  if (s === "queue:manual" || s === "manual") {
    return { kind: "manual", label: "Manual run", automation: true };
  }
  if (s === "cli") return CLI_SOURCE;
  return { kind: "app", label: "App session", automation: false };
}

/** Short one/two-word label for tight spots (the in-session pill). */
export function shortSourceLabel(kind: SourceKind): string {
  switch (kind) {
    case "github-issue":
    case "github-mention":
      return "GitHub";
    case "slack":
      return "Slack";
    case "linear":
      return "Linear";
    case "schedule":
      return "Schedule";
    case "webhook":
      return "Webhook";
    case "manual":
      return "Manual";
    case "cli":
      return "CLI";
    case "app":
      return "App";
  }
}
