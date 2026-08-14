// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { SessionContract, SessionContractArea } from "@bivy/core";
import { useAppState, controller } from "../store/useStore.js";
import { Sheet } from "./Sheet.js";
import { SANDBOX_TIERS } from "./Settings.js";

const STATE_LABEL: Record<string, string> = { guaranteed: "Guaranteed", degraded: "Degraded", unavailable: "Unavailable" };

function areaRows(contract: SessionContract): Array<{ area: SessionContractArea; label: string; detail: string; state: string }> {
  return [
    {
      area: "agent",
      label: "Agent",
      detail: `${contract.agent.displayName || contract.agent.id}${contract.agent.detectedVersion ? ` ${contract.agent.detectedVersion}` : " (version unknown)"}`,
      state: contract.agent.versionSource === "unknown" ? "degraded" : "guaranteed",
    },
    {
      area: "executionMode",
      label: "Streaming",
      detail: contract.executionMode.structuredStreaming ? "Structured protocol stream" : `Raw ${contract.executionMode.effective} pipe`,
      state: contract.executionMode.state,
    },
    {
      area: "auth",
      label: "Credential",
      detail: contract.auth.kind === "unknown" ? "Not identified" : `${contract.auth.kind} via ${contract.auth.origin}`,
      state: contract.auth.state,
    },
    {
      area: "resume",
      label: "Resume",
      detail: contract.resume.advertised ? "Supported" : "Not supported by this agent",
      state: contract.resume.state,
    },
    {
      area: "toolInterception",
      label: "Tool approvals",
      detail: contract.toolInterception.enforced
        ? "Every tool call gated"
        : contract.toolInterception.mcpOnly
          ? "MCP tool calls only"
          : "Not intercepted",
      state: contract.toolInterception.state,
    },
    {
      area: "sandbox",
      label: "Sandbox",
      detail: contract.sandbox.tier ? `${contract.sandbox.tier} · ${contract.sandbox.runtimeEnforcement}` : contract.sandbox.runtimeEnforcement,
      state: contract.sandbox.state,
    },
  ];
}

/** Read-only inspector for the session's resolved Effective Session Contract
 *  (see packages/core/src/session-contract.ts) — what this specific session
 *  actually got, as distinct from the agent picker's pre-launch preview. */
function SessionContractInspector({ contract }: { contract: SessionContract }) {
  return (
    <div className="settings-form">
      <label className="field-label">Session contract</label>
      <p className="muted small">
        Resolved {new Date(contract.resolvedAt).toLocaleString()} · {contract.supportTier}
        {contract.requiresAcknowledgement ? " · needs acknowledgement" : contract.acknowledgedAt ? " · acknowledged" : ""}
      </p>
      <ul className="contract-areas">
        {areaRows(contract).map((row) => (
          <li key={row.area} className={`contract-area contract-area-${row.state}`}>
            <span className="contract-area-label">{row.label}</span>
            <span className="contract-area-state">{STATE_LABEL[row.state] || row.state}</span>
            <span className="contract-area-detail muted small">{row.detail}</span>
          </li>
        ))}
      </ul>
      {contract.degradedReasons.length > 0 && (
        <ul className="contract-reasons muted small">
          {contract.degradedReasons.map((reason) => (
            <li key={`${reason.area}-${reason.code}`}>{reason.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Per-session settings sheet — today just the sandbox mode. It's the escape
 * hatch for agents (e.g. Codex) whose own sandbox is too restrictive for what
 * you're doing.
 *
 * The tier bakes into the agent's native launch flags when the session is
 * created, so it's chosen up front and fixed for the life of the run. This sheet
 * is therefore context-aware:
 *   • No active session (a fresh draft) → an editable picker that sets the tier
 *     for the next session you start (a blank choice defers to the node default).
 *   • A running session → the session's sandbox mode, shown read-only. To run
 *     under a different one, start a new session (or hand off to another agent).
 */
export function SessionSettings({ onClose }: { onClose: () => void }) {
  const state = useAppState();
  const { settings: { nodeSettings }, activeSession: { activeSessionId }, sessionIndex: { sessions } } = state;
  const draftSandbox = state.draft.sandbox;
  const nodeDefault = nodeSettings?.defaultSandbox;
  const running = Boolean(activeSessionId);
  const activeSession = activeSessionId ? sessions.find((s) => s.sessionId === activeSessionId) : undefined;
  const sessionTier = activeSession?.sandbox;
  const sessionTierLabel = sessionTier
    ? SANDBOX_TIERS.find((t) => t.id === sessionTier)?.label ?? sessionTier
    : `Machine default${nodeDefault ? ` (${nodeDefault})` : ""}`;
  const sessionTierHint = sessionTier
    ? SANDBOX_TIERS.find((t) => t.id === sessionTier)?.hint
    : "This session runs at the machine's configured sandbox mode.";

  return (
    <Sheet title="Session settings" onClose={onClose} autoFocusSearch={false}>
      <div className="settings-form">
        <label className="field-label">Sandbox mode</label>
        {running ? (
          <>
            <div className="seg-row">
              <span className="seg-btn active" aria-disabled="true" title={sessionTierHint}>
                {sessionTierLabel}
              </span>
            </div>
            {sessionTierHint && <p className="muted small">{sessionTierHint}</p>}
            <p className="muted">
              The sandbox mode is fixed for the life of a session. Start a new session (or hand off to another agent) to
              run under a different one.
            </p>
          </>
        ) : (
          <>
            <div className="seg-row">
              <button
                type="button"
                className={`seg-btn${!draftSandbox ? " active" : ""}`}
                onClick={() => controller.setSessionSandbox(null)}
                title="Use the machine's default sandbox mode"
              >
                Machine default{nodeDefault ? ` (${nodeDefault})` : ""}
              </button>
              {SANDBOX_TIERS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`seg-btn${draftSandbox === t.id ? " active" : ""}`}
                  onClick={() => controller.setSessionSandbox(t.id)}
                  title={t.hint}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p className="muted small">
              {draftSandbox
                ? SANDBOX_TIERS.find((t) => t.id === draftSandbox)?.hint
                : "Falls back to the machine default. Change it in Settings → Machines."}
            </p>
            <p className="muted">
              Applies to the next session you start. Existing sessions keep the sandbox they were created with — start a
              new session (or switch agent) to run under a different one.
            </p>
          </>
        )}
      </div>
      {activeSession?.contract && <SessionContractInspector contract={activeSession.contract} />}
    </Sheet>
  );
}
