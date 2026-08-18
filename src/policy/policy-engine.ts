// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { catastrophicFloor, guardToolCall, type ApprovalMode, type GuardDecision } from "../guard.js";
import { riskCategoryForTool, type RiskCategory } from "./risk.js";

export interface PolicyDecision {
  decision: GuardDecision;
  reason?: string;
  risk: RiskCategory;
}

export interface PolicyEngineOptions {
  mode: ApprovalMode;
  isRiskyIntegration?: (toolName: string) => boolean;
  /** Explicit full-access opt-out (`danger-full-access`): skip Bivy's approval
   * prompts and the workspace-write boundary. It does NOT lift the catastrophic
   * command floor — that holds in every mode and every tier. Interaction tools
   * are handled before the policy engine, and a paused session may still ask at
   * the caller. */
  unrestricted?: boolean;
}

/** Runtime-agnostic policy decision layer. Strong runtimes call this before tools.
 *  Persistent "remembered decisions" were removed — the engine now only applies
 *  the mode-based guard floor; governance beyond that is left to the agents. */
export class PolicyEngine {
  constructor(private readonly options: PolicyEngineOptions) {}

  decideToolCall(workspace: string, toolName: string, input: unknown): PolicyDecision {
    const risk = riskCategoryForTool(toolName);

    // The catastrophic floor is evaluated first, before any opt-out, so
    // `rm -rf /`, `mkfs`, a fork bomb, etc. are denied even at
    // danger-full-access. Nothing configurable sits above this line.
    const catastrophic = catastrophicFloor(toolName, input);
    if (catastrophic) return { ...catastrophic, risk };

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
