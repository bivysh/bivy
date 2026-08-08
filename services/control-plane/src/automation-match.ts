// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Match inbound source events (GitHub, Linear) against account automation
// definitions. Schedule/webhook keep their own intake paths; this module is for
// "work lives upstream" triggers where the event carries the workspace.
import type { AutomationDefinition } from "./store.js";

export type SourceTriggerKind = "github" | "linear";

export interface SourceTriggerEvent {
  kind: SourceTriggerKind;
  /** owner/name when known */
  repo?: string;
  /** Labels on the issue / ticket. */
  labels: string[];
  /** @-mention / slash-style intake — label filter is skipped (historical:
   *  mentioning the bot always starts work; labels only gate label-based routing). */
  mention?: boolean;
}

const SENTINEL_SCHEDULE = { kind: "once" as const, at: "9999-12-31T00:00:00.000Z" };

/** Built-in source automations seeded when a matching hook exists. */
export const SOURCE_AUTOMATION_SEEDS: Record<
  SourceTriggerKind,
  { name: string; templateId: string; labels: string[] }
> = {
  github: {
    name: "Work issues into PRs",
    templateId: "issue-to-pr",
    labels: ["bivy"],
  },
  linear: {
    name: "Work Linear issues into PRs",
    templateId: "issue-to-pr",
    labels: ["bivy"],
  },
};

export function isSourceTrigger(trigger: AutomationDefinition["trigger"]): trigger is SourceTriggerKind {
  return trigger === "github" || trigger === "linear";
}

/**
 * First matching enabled source automation wins (stable: createdAt ascending).
 * Empty `labels` / `repos` on the definition means "default bivy* labels" /
 * "all repos".
 */
export function matchSourceAutomation(
  definitions: AutomationDefinition[],
  event: SourceTriggerEvent,
): AutomationDefinition | undefined {
  const candidates = definitions
    .filter((d) => d.enabled !== false && d.trigger === event.kind)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const def of candidates) {
    if (!repoAllowed(def.repos, event.repo)) continue;
    if (!event.mention && !labelsMatch(def.labels, event.labels)) continue;
    return def;
  }
  return undefined;
}

/** Repo allowlist: undefined/empty = all; otherwise exact owner/name match. */
export function repoAllowed(allowlist: string[] | undefined, repo: string | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  if (!repo) return false;
  const want = repo.trim().toLowerCase();
  return allowlist.some((r) => r.trim().toLowerCase() === want);
}

/**
 * Label filter. Default (no labels configured) accepts any label that starts
 * with `bivy` (historical contract: `bivy` or `bivy/<node>`). Explicit labels
 * match exactly or as a `label/<node>` prefix form.
 */
export function labelsMatch(filter: string[] | undefined, eventLabels: string[]): boolean {
  const normalized = eventLabels.map((l) => l.trim().toLowerCase()).filter(Boolean);
  const filters = (filter && filter.length > 0 ? filter : ["bivy"]).map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (filters.length === 0) return true;
  return normalized.some((label) =>
    filters.some((f) => label === f || label.startsWith(`${f}/`)),
  );
}

/** Normalize optional string arrays from API bodies. */
export function normalizeStringList(value: unknown, max = 50): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("expected a string array");
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("expected a string array");
    const t = item.trim();
    if (!t) continue;
    if (t.length > 120) throw new Error("list entry too long");
    out.push(t);
    if (out.length > max) throw new Error(`at most ${max} entries`);
  }
  return out;
}

/** Input for seeding a source automation when a hook exists but no definition does. */
export function sourceAutomationSeedInput(kind: SourceTriggerKind): Omit<
  AutomationDefinition,
  "id" | "accountId" | "createdAt" | "updatedAt"
> {
  const seed = SOURCE_AUTOMATION_SEEDS[kind];
  return {
    name: seed.name,
    templateId: seed.templateId,
    trigger: kind,
    labels: seed.labels,
    enabled: true,
    // Park off the scheduler — source automations fire from webhooks only.
    schedule: SENTINEL_SCHEDULE,
    nextRunAt: undefined,
  };
}
