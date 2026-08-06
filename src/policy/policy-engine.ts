// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { guardToolCall, type ApprovalMode, type GuardDecision } from "../guard.js";
import { riskCategoryForTool, type RiskCategory } from "./risk.js";

export interface PolicyDecision {
  decision: GuardDecision;
  reason?: string;
  risk: RiskCategory;
}

export interface PolicyEngineOptions {
  mode: ApprovalMode;
  isRiskyIntegration?: (toolName: string) => boolean;
  /** Explicit full-access opt-out: allow every tool without applying Bivy's
   * approval or containment policy. Interaction tools are handled before the
   * policy engine, and a paused session may still ask at the caller. */
  unrestricted?: boolean;
}

/** Runtime-agnostic policy decision layer. Strong runtimes call this before tools.
 *  Persistent "remembered decisions" were removed — the engine now only applies
 *  the mode-based guard floor; governance beyond that is left to the agents. */
export class PolicyEngine {
  constructor(private readonly options: PolicyEngineOptions) {}

  decideToolCall(workspace: string, toolName: string, input: unknown): PolicyDecision {
    const risk = riskCategoryForTool(toolName);
    if (this.options.unrestricted) return { decision: "allow", risk };

    const base = guardToolCall(
      workspace,
      toolName,
      input,
      this.options.mode,
      this.options.isRiskyIntegration ?? (() => false),
    );
    return { ...base, risk };
  }
}
