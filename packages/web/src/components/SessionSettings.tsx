// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useAppState, controller } from "../store/useStore.js";
import { Sheet } from "./Sheet.js";
import { SANDBOX_TIERS } from "./Settings.js";

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
  const { draftSandbox, nodeSettings, activeSessionId, sessions } = state;
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
    </Sheet>
  );
}
