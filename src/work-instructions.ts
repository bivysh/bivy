// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Which instructions a queued run may give the agent. The control plane relays
 * work but must not be able to author it, so instructions come only from:
 * - a template sealed to this node (`bivy-room-v1:`), opened before this runs;
 * - content the node fetches itself from the source (GitHub, Linear);
 * - a prompt built into the node (CI failures without a template);
 * - a Slack prompt, which the control plane relays in plaintext, only when this
 *   node has turned Slack prompts on.
 * Anything else the control plane sends in plaintext (a title, an unsealed body)
 * is a label, never part of the prompt.
 */

/** Built-in prompt for a failed CI build when its automation has no template. */
export const FIX_CI_PROMPT = `Investigate a failed CI build and prepare a tested fix.

1. Use the incoming event context (build URL, job name, conclusion) to locate the failure. Fetch logs with credentials already on this machine — never ask the event for secrets.
2. Reproduce the failure locally with the project's own test/CI commands.
3. Make the smallest safe fix. Do not refactor unrelated code.
4. Run the affected checks and the project's tests, linter, and type checks.
5. Commit on a new branch and open a pull request that links the failing build and summarises the root cause and the checks that passed.

If the failure cannot be reproduced or is clearly an infrastructure flake, make no code changes and report the evidence.`;

/** What to do with a run whose instructions arrived unsealed, by source. */
const UNSEALED: Record<string, "fetched" | "builtin-ci" | "slack"> = {
  "github:issue": "fetched",
  "github:comment": "fetched",
  "linear:issue": "fetched",
  "github:ci": "builtin-ci",
  slack: "slack",
};

export interface QueuedInstructions { source: string; title: string; body?: string }

export type InstructionsDecision =
  /** `body` replaces the item's body; only a Slack prompt's title is part of the prompt. */
  | { ok: true; body?: string; titleInPrompt: boolean }
  | { ok: false; reason: string };

export const SLACK_PROMPTS_OFF = "Slack prompts are off on this machine. Turn them on with `bivy config set automation.slackPrompts true` and restart Bivy.";

export function trustedInstructions(item: QueuedInstructions, opts: { sealed: boolean; slackPrompts: boolean }): InstructionsDecision {
  if (opts.sealed) return { ok: true, body: item.body, titleInPrompt: false };
  switch (UNSEALED[item.source]) {
    case "fetched": return { ok: true, body: undefined, titleInPrompt: false };
    case "builtin-ci": return { ok: true, body: FIX_CI_PROMPT, titleInPrompt: false };
    case "slack":
      return opts.slackPrompts ? { ok: true, body: item.body, titleInPrompt: true } : { ok: false, reason: SLACK_PROMPTS_OFF };
    default:
      return { ok: false, reason: "This run's instructions aren't end-to-end encrypted for this machine, so it won't run them. Save the automation again from the app to re-encrypt it." };
  }
}

/** The prompt for a generic run, after `trustedInstructions` and any event context. */
export function runPrompt(item: { title: string; body?: string }, titleInPrompt: boolean): string {
  if (!titleInPrompt) return item.body ?? "";
  return item.body ? `${item.title}\n\n${item.body}` : item.title;
}
