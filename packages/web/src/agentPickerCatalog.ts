// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { RuntimeInfo } from "@bivy/core";

// Keep the most commonly used agents together at the top of the picker. Runtime
// IDs are stable even when a product's display name changes.
const TOP_AGENT_IDS = new Set([
  "claude-code-sdk",
  "codex-approvals",
  "grok",
  "opencode",
  "pi",
]);

export function agentPickerLabel(runtime: RuntimeInfo): string {
  return String(runtime.displayName || runtime.name || runtime.id || "Agent");
}

export function isTopAgent(runtime: RuntimeInfo): boolean {
  return TOP_AGENT_IDS.has(runtime.id);
}

export function filterAndSortAgentRuntimes(runtimes: RuntimeInfo[], query: string): RuntimeInfo[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matched = normalizedQuery
    ? runtimes.filter((runtime) => agentPickerLabel(runtime).toLocaleLowerCase().includes(normalizedQuery))
    : runtimes;

  return [...matched].sort((a, b) =>
    agentPickerLabel(a).localeCompare(agentPickerLabel(b), undefined, { sensitivity: "base" }),
  );
}
