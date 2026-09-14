// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The first-session decision set (B2). A brand-new session should expose exactly
// four decisions — machine, repository, agent/model, and protection — and no more.
// This derives that ordered, labelled set from the values the composer already
// has, so the draft can show a single explicit "Starting on …" summary instead of
// leaving a new user to infer the four from scattered pills.

export type FirstSessionDecisionKey = "machine" | "repo" | "agent-model" | "protection";

export interface FirstSessionDecision {
  key: FirstSessionDecisionKey;
  label: string;
  value: string;
}

export interface FirstSessionInputs {
  machine?: string;
  repo?: string;
  agent?: string;
  model?: string;
  /** True when the agent owns model selection (Codex etc.) — fold it into agent. */
  modelManagedByAgent?: boolean;
  protection?: string;
}

/**
 * The canonical four first-session decisions, in golden-path order. Agent and
 * model are one decision ("agent/model"); the model half is omitted when the
 * agent manages its own model. Missing values use actionable customer copy —
 * never implementation placeholders such as "unknown" or an em dash.
 */
export function firstSessionDecisions(input: FirstSessionInputs): FirstSessionDecision[] {
  const agent = input.agent?.trim() || "Choose an agent";
  const model = input.model?.trim() && input.model.trim().toLowerCase() !== "unknown" ? input.model.trim() : "Choose a model";
  const agentModel = input.modelManagedByAgent || !model ? agent : `${agent} · ${model}`;
  return [
    { key: "machine", label: "Machine", value: input.machine?.trim() || "Machine default" },
    { key: "repo", label: "Repository", value: input.repo?.trim() || "No repository" },
    { key: "agent-model", label: "Agent / Model", value: agentModel },
    { key: "protection", label: "Protection", value: input.protection?.trim() || "Machine default" },
  ];
}

/** One-line summary of the four decisions for the draft composer. */
export function firstSessionSummary(input: FirstSessionInputs): string {
  return firstSessionDecisions(input).map((d) => d.value).join("  ·  ");
}
