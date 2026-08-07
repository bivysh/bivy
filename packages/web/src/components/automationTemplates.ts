// SPDX-License-Identifier: AGPL-3.0-only
//
// First-party automation templates. A template is *not* a new runtime or a new
// stored object — it is a preset that pre-fills the ordinary "create automation"
// form (schedule templates) or points at the panel that already configures the
// right trigger (external templates). This keeps "create an automation" concrete
// ("upgrade dependencies on a schedule") while reusing Bivy's existing automation
// system unchanged: a schedule template just yields the same POST /account/automations
// payload the blank form produces today.

export type AutomationApprovalMode = "never" | "risky" | "always" | "autonomous";
export type AutomationSandbox = "read-only" | "workspace-write" | "danger-full-access";

/** A template whose "Use template" action pre-fills the scheduled-automation form. */
export interface ScheduleTemplate {
  kind: "schedule";
  key: string;
  title: string;
  /** One-line outcome, shown under the title. */
  tagline: string;
  /** Values dropped into the create form; the user reviews and can edit before saving. */
  prefill: {
    name: string;
    instructions: string;
    /** Human phrase shown in the "When to run" box, plus the cron it resolves to. */
    schedule: { nlText: string; cron: string };
    approvalMode: AutomationApprovalMode;
    sandbox: AutomationSandbox;
  };
}

/** A template whose trigger lives in another panel (webhooks, work queue). Its
 *  action navigates there rather than pre-filling the schedule form, so the
 *  Automations page stays the single place to discover every job. */
export interface ExternalTemplate {
  kind: "external";
  key: string;
  title: string;
  tagline: string;
  /** Which existing settings panel configures this trigger. */
  route: "webhooks" | "queue";
  /** Short call-to-action for the button, e.g. "Set up in Webhooks". */
  cta: string;
}

export type AutomationTemplate = ScheduleTemplate | ExternalTemplate;

// The instruction blocks below become the (client-side encrypted) prompt the
// node runs. They mirror the shape of Bivy's default issue instructions:
// understand → make the smallest safe change → run the project's checks → open a
// PR → do nothing when there is nothing to do.

const UPGRADE_DEPENDENCIES_INSTRUCTIONS = `Update this project's dependencies to safe, current versions.

1. Inspect the manifest and lockfile to find what is outdated.
2. Apply patch and minor upgrades first. Take a major upgrade only when its changelog shows no breaking change that affects this repository.
3. Regenerate the lockfile.
4. Run the project's tests, linter, and type checks. Fix breakage the upgrade introduced; if a dependency cannot be upgraded cleanly, leave it at its current version and note why.
5. Keep the change scoped to dependency updates — do not refactor unrelated code.
6. Commit on a new branch and open a pull request that summarises what moved and which checks passed.

If nothing is outdated, make no changes and report that dependencies are already current.`;

const SECURITY_AUDIT_INSTRUCTIONS = `Audit this project's dependencies for known vulnerabilities and prepare a safe fix.

1. Run the ecosystem's audit tool (for example npm audit, pip-audit, or cargo audit) to list known advisories.
2. For each advisory, apply the smallest upgrade that resolves it without a breaking change.
3. Regenerate the lockfile, then run the project's tests, linter, and type checks.
4. Do not change application logic beyond what a dependency bump requires.
5. Commit on a new branch and open a pull request listing each advisory addressed, the version change, and which checks passed. Call out any advisory that cannot be fixed without a breaking change instead of forcing it.

If the audit is clean, make no changes and report that no known vulnerabilities were found.`;

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    kind: "schedule",
    key: "upgrade-dependencies",
    title: "Upgrade dependencies",
    tagline: "Bump dependencies on a schedule, run the checks, open a PR.",
    prefill: {
      name: "Upgrade dependencies",
      instructions: UPGRADE_DEPENDENCIES_INSTRUCTIONS,
      schedule: { nlText: "every monday at 9am", cron: "0 9 * * 1" },
      approvalMode: "autonomous",
      sandbox: "workspace-write",
    },
  },
  {
    kind: "schedule",
    key: "dependency-security-audit",
    title: "Dependency security audit",
    tagline: "Scan dependencies for advisories and prepare a tested fix.",
    prefill: {
      name: "Dependency security audit",
      instructions: SECURITY_AUDIT_INSTRUCTIONS,
      schedule: { nlText: "every thursday at 9am", cron: "0 9 * * 4" },
      approvalMode: "autonomous",
      sandbox: "workspace-write",
    },
  },
  {
    kind: "external",
    key: "fix-failed-ci",
    title: "Fix failed CI",
    tagline: "Turn a CI failure webhook into a diagnosed, tested fix.",
    route: "webhooks",
    cta: "Set up in Webhooks",
  },
  {
    kind: "external",
    key: "investigate-production-errors",
    title: "Investigate production errors",
    tagline: "Route monitoring alerts to a read-only investigation and a proposed patch.",
    route: "webhooks",
    cta: "Set up in Webhooks",
  },
  {
    kind: "external",
    key: "work-issues-into-prs",
    title: "Work issues into PRs",
    tagline: "Label a GitHub or Linear issue and let a node open the pull request.",
    route: "queue",
    cta: "Set up in Work Queue",
  },
];
