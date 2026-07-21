// SPDX-License-Identifier: FSL-1.1-ALv2
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
}

/** Runtime-agnostic policy decision layer. Strong runtimes call this before tools.
 *  Persistent "remembered decisions" were removed — the engine now only applies
 *  the mode-based guard floor; governance beyond that is left to the agents. */
export class PolicyEngine {
  constructor(private readonly options: PolicyEngineOptions) {}

  decideToolCall(workspace: string, toolName: string, input: unknown): PolicyDecision {
    const base = guardToolCall(
      workspace,
      toolName,
      input,
      this.options.mode,
      this.options.isRiskyIntegration ?? (() => false),
    );
    const risk = riskCategoryForTool(toolName);
    return { ...base, risk };
  }
}
