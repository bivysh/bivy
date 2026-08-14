// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// "Schedule this message for later": choose it from the split Send control to open
// this sheet. It writes a one-off scheduled message onto the account's control
// plane (AppController.scheduleMessage → createAutomation with `message: true`),
// E2E-sealed for the session's owning node, so the always-on node delivers it
// even when this app is closed. The target is inferred from the current screen —
// a live session schedules into that thread, a draft starts a new one — so the
// sheet doesn't ask "this or new session". For an existing session the scheduled
// message also lands as a timestamped, cancellable row in the session's
// follow-up queue (FollowupQueue), so it's visible next to the composer, not
// just here.
import { useState } from "react";
import type { AppState } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { Sheet } from "./Sheet.js";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** A `<input type="datetime-local">` value for a Date (local wall-clock). */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultSlot(): string {
  const d = new Date(Date.now() + 10 * 60 * 1000);
  d.setSeconds(0, 0);
  return toLocalInput(d);
}

export function ScheduleSheet({
  state,
  text,
  onClose,
  onScheduled,
}: {
  state: AppState;
  text: string;
  onClose: () => void;
  /** Fired once a message is successfully scheduled — clears the composer. */
  onScheduled: () => void;
}) {
  const [at, setAt] = useState(defaultSlot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scheduled, setScheduled] = useState("");

  // The target is inferred from the screen we're on: an open session schedules
  // into that thread; a draft (no active session) starts a fresh one on the
  // machine picked there. No radio, no wrong pick.
  const active = state.activeSession.activeSessionId ? state.sessionIndex.sessions.find((s) => s.sessionId === state.activeSession.activeSessionId) : undefined;
  const target: "existing_session" | "new_session" = active ? "existing_session" : "new_session";
  const nodeId = active?.nodeId ?? state.connection.currentNodeId;
  const node = state.connection.nodes.find((n) => n.id === nodeId);
  const roomKeyReady = Boolean(nodeId && controller.local.keys()[nodeId]);

  async function schedule() {
    setBusy(true);
    setError("");
    setScheduled("");
    try {
      const err = await controller.scheduleMessage({
        text,
        at: new Date(at),
        target,
        sessionId: active?.sessionId,
      });
      if (err) {
        setError(err);
        return;
      }
      setScheduled(
        `Scheduled for ${new Date(at).toLocaleString()} — delivered by ${node?.name ?? "your machine"}, even if the app is closed.`,
      );
      onScheduled();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Schedule message" onClose={onClose} autoFocusSearch={false}>
      <div className="schedule-sheet">
        <p className="schedule-preview">{text.trim()}</p>
        <label className="schedule-field">
          <span className="schedule-label">Send at</span>
          <input
            type="datetime-local"
            className="schedule-input"
            value={at}
            min={toLocalInput(new Date())}
            onChange={(e) => setAt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void schedule();
              }
            }}
          />
        </label>

        <p className="schedule-target-note">
          {active
            ? `Delivered into this session by ${node?.name ?? "its machine"} — it will also show in the queue above.`
            : `Delivered as a new session on ${node?.name ?? "the selected machine"}.`}
        </p>

        {error && <p className="schedule-error">{error}</p>}
        {scheduled && <p className="schedule-ok">{scheduled}</p>}

        <button type="button" className="queue-action-btn active schedule-send" disabled={busy || !roomKeyReady} onClick={() => void schedule()}>
          {busy ? "Scheduling…" : "Schedule"}
        </button>
      </div>
    </Sheet>
  );
}
