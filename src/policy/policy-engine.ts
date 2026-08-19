// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { bashCommand, catastrophicFloor, guardToolCall, isShellTool, looksBackstop, type ApprovalMode, type GuardDecision } from "../guard.js";
import { riskCategoryForTool, type RiskCategory } from "./risk.js";
import { approvalRememberKey } from "./session-allow.js";

export interface PolicyDecision {
  decision: GuardDecision;
  reason?: string;
  risk: RiskCategory;
  /** Set on an `ask` the user may answer with "allow this for the rest of the
   *  session" (see session-allow.ts). Absent on backstop / risky-integration
   *  asks — those always prompt, whatever the user remembered. */
  rememberKey?: string;
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
  /** Session-scoped "always allow" lookup by remember key. Consulted only for
   *  mode-driven asks; never for the floor or the backstop set. */
  isRemembered?: (rememberKey: string) => boolean;
}

/** Runtime-agnostic policy decision layer. Strong runtimes call this before tools.
 *  Persistent "remembered decisions" were removed — the engine applies the
 *  mode-based guard floor plus optional in-memory, session-scoped allow rules;
 *  governance beyond that is left to the agents. */
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

    const isRiskyIntegration = this.options.isRiskyIntegration ?? (() => false);
    const base = guardToolCall(workspace, toolName, input, this.options.mode, isRiskyIntegration);
    if (base.decision !== "ask") return { ...base, risk };

    // Backstop commands (force-push, publish, deploy, sudo, …) and risky
    // integrations prompt every time; a remembered rule cannot reach them.
    const backstop = (isShellTool(toolName) && looksBackstop(bashCommand(input))) || isRiskyIntegration(toolName);
    if (backstop) return { ...base, risk };

    const rememberKey = approvalRememberKey(toolName, input);
    if (this.options.isRemembered?.(rememberKey)) {
      return { decision: "allow", risk, reason: `Allowed for this session: ${rememberKey}` };
    }
    return { ...base, risk, rememberKey };
  }
}
