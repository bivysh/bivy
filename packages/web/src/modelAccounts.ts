// SPDX-License-Identifier: AGPL-3.0-only
import type { AppState, CredentialPresetsView, CredentialRecordSummary } from "@bivy/core";

export function modelAccountProject(state: AppState): string | null | undefined {
  const sessionId = state.activeSession.activeSessionId;
  const session = state.sessionIndex.sessions.find((s) => s.sessionId === sessionId);
  return sessionId ? session?.worktree || session?.workspace || state.activeSession.github.repo : state.draft.repo;
}

/** Mirror credential routing: project > active preset > default mapping > default label > only record. */
export function modelAccountChoice(
  provider: string,
  records: Pick<CredentialRecordSummary, "label">[],
  config: CredentialPresetsView | null,
  project?: string | null,
): { preset: string; label?: string } {
  const preset = project ? `project:${project}` : config?.active || "default";
  if (!config) return { preset };
  const mappings = config.presets ?? {};
  // Live local sessions identify projects by absolute workspace first; managed
  // clones also carry owner__repo in the path (the node's routing convention).
  const parts = project?.split(/[/\\]/).filter(Boolean) ?? [];
  const aliases = project?.startsWith("/")
    ? [project, parts.at(-1), ...parts.filter((part) => part.includes("__")).map((part) => part.replace("__", "/"))]
    : [project];
  const projectMapping = aliases.filter(Boolean).map((id) => mappings[`project:${id}`]?.[provider]).find(Boolean);
  const selected = projectMapping || (config.active ? mappings[config.active]?.[provider] : undefined);
  // A dangling active mapping is not permission to silently use another account.
  if (selected) return { preset, label: records.find((r) => r.label === selected)?.label };
  const fallback = records.find((r) => r.label === mappings.default?.[provider])
    ?? records.find((r) => r.label === "default")
    ?? (records.length === 1 ? records[0] : undefined);
  return { preset, label: fallback?.label };
}
