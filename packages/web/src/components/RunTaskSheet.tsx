// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// One message can start a durable Run without changing the identity of the
// Session that supplies its context. Opened from the composer's split Send
// menu; ordinary Send remains the default action.
import { useState } from "react";
import type { AppState } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { Sheet } from "./Sheet.js";

export function RunTaskSheet({
  state,
  text,
  onClose,
  onStarted,
}: {
  state: AppState;
  text: string;
  onClose: () => void;
  onStarted: (runId: string) => void;
}) {
  const [approvalMode, setApprovalMode] = useState<"risky" | "autonomous">("risky");
  const [maxAttempts, setMaxAttempts] = useState(2);
  const [acknowledgeDangerous, setAcknowledgeDangerous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const active = state.activeSession.activeSessionId
    ? state.sessionIndex.sessions.find((session) => session.sessionId === state.activeSession.activeSessionId)
    : undefined;
  const sandbox = active?.sandbox ?? state.draft.sandbox ?? state.settings.nodeSettings?.defaultSandbox;
  const dangerous = approvalMode === "autonomous" && sandbox === "danger-full-access";
  const unsupportedDraft = !active && state.draft.ephemeralConfig
    ? "Start the isolated Machine’s Session first, then start a Run from that Session."
    : !active && state.draft.branch
      ? "Runs currently start from a repository’s default branch. Choose the default branch before starting."
      : null;

  async function start() {
    if (unsupportedDraft || (dangerous && !acknowledgeDangerous)) return;
    setBusy(true);
    setError("");
    const result = await controller.startRun(text, { approvalMode, maxAttempts });
    if (result.runId) {
      onStarted(result.runId);
      return;
    }
    setError(result.error ?? "Could not start this Run.");
    setBusy(false);
  }

  return (
    <Sheet title="Start a Run" onClose={busy ? () => {} : onClose} autoFocusSearch={false}>
      <div className="run-task-sheet">
        <p className="schedule-preview">{text.trim()}</p>
        <p className="run-task-intro">
          Bivy tracks this task through completion with checks, evidence, and recovery. You can continue to follow and steer the Session.
        </p>

        <label className="schedule-field">
          <span className="schedule-label">Approval</span>
          <select className="field" value={approvalMode} onChange={(event) => setApprovalMode(event.target.value as "risky" | "autonomous")} disabled={busy}>
            <option value="risky">Ask for risky actions</option>
            <option value="autonomous">Autonomous</option>
          </select>
        </label>
        <label className="schedule-field">
          <span className="schedule-label">Attempts</span>
          <select className="field" value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))} disabled={busy}>
            <option value={1}>1 attempt</option>
            <option value={2}>Up to 2 attempts</option>
            <option value={3}>Up to 3 attempts</option>
          </select>
        </label>

        <p className="schedule-target-note">
          {active ? "Uses this Session’s" : "Starts a new Session with the selected"} machine, repository, agent, model, and protection
          {sandbox ? ` (${sandbox})` : ""}.
        </p>

        {unsupportedDraft && <p className="schedule-error" role="alert">{unsupportedDraft}</p>}
        {dangerous && (
          <label className="run-task-danger">
            <input type="checkbox" checked={acknowledgeDangerous} onChange={(event) => setAcknowledgeDangerous(event.target.checked)} disabled={busy} />
            <span>I understand that autonomous execution with full access can act anywhere my OS user can.</span>
          </label>
        )}
        {error && <p className="schedule-error" role="alert">{error}</p>}

        <button type="button" className="queue-action-btn active schedule-send" disabled={busy || Boolean(unsupportedDraft) || (dangerous && !acknowledgeDangerous)} onClick={() => void start()}>
          {busy ? "Starting…" : "Start Run"}
        </button>
      </div>
    </Sheet>
  );
}
