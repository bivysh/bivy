// SPDX-License-Identifier: FSL-1.1-ALv2
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

const DASH = "—";

/**
 * The canonical four first-session decisions, in golden-path order. Agent and
 * model are one decision ("agent/model"); the model half is omitted when the
 * agent manages its own model. Missing values render as an em dash, never as a
 * fifth or vanished decision — the set is always exactly four.
 */
export function firstSessionDecisions(input: FirstSessionInputs): FirstSessionDecision[] {
  const agent = input.agent?.trim() || DASH;
  const model = input.model?.trim();
  const agentModel = input.modelManagedByAgent || !model ? agent : `${agent} · ${model}`;
  return [
    { key: "machine", label: "Machine", value: input.machine?.trim() || DASH },
    { key: "repo", label: "Repository", value: input.repo?.trim() || DASH },
    { key: "agent-model", label: "Agent/model", value: agentModel },
    { key: "protection", label: "Protection", value: input.protection?.trim() || DASH },
  ];
}

/** One-line summary of the four decisions for the draft composer. */
export function firstSessionSummary(input: FirstSessionInputs): string {
  return firstSessionDecisions(input).map((d) => d.value).join("  ·  ");
}
