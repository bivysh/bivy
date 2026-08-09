// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// "Schedule this message for later": long-press Send in the composer to open
// this sheet. It writes a one-off scheduled message onto the account's control
// plane (`createAutomation` with `message: true`), E2E-sealed for the session's
// owning node, so the always-on node delivers it even when this app is closed.
// Targeting an existing session resumes that thread when the time comes; a new
// session uses the draft's machine/repo. Pending messages for this session are
// listed so they can be cancelled before they fire.
import { useEffect, useMemo, useState } from "react";
import {
  createAutomation,
  deleteAutomation,
  fetchAutomations,
  importRoomKey,
  seal,
  unb64,
  type AccountAutomation,
  type AppState,
} from "@bivy/core";
import { controller } from "../store/useStore.js";
import { Sheet } from "./Sheet.js";

const TEMPLATE_PREFIX = "bivy-room-v1";

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

type Target = "existing_session" | "new_session";

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
  const [target, setTarget] = useState<Target>(state.activeSessionId ? "existing_session" : "new_session");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scheduled, setScheduled] = useState("");
  const [pending, setPending] = useState<AccountAutomation[]>([]);

  const activeSession = useMemo(
    () => state.sessions.find((s) => s.sessionId === state.activeSessionId),
    [state.sessions, state.activeSessionId],
  );
  // Existing-session messages are sealed for (and routed to) the session's
  // owning node; a new-session message uses the machine selected on the draft.
  const nodeId = target === "existing_session" ? activeSession?.nodeId : state.currentNodeId;
  const node = state.nodes.find((n) => n.id === nodeId);
  const nodeLabel = node?.name ? `bivy/${node.name}` : undefined;
  const roomKeyReady = Boolean(nodeId && controller.local.keys()[nodeId]);

  async function loadPending() {
    try {
      const all = await fetchAutomations(controller.local);
      setPending(
        all
          .filter(
            (a) =>
              a.message === true &&
              a.targetKind === "existing_session" &&
              a.targetSessionId === state.activeSessionId &&
              a.enabled,
          )
          .sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? "")),
      );
    } catch {
      setPending([]);
    }
  }

  useEffect(() => {
    void loadPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function schedule() {
    setBusy(true);
    setError("");
    setScheduled("");
    try {
      if (!text.trim()) throw new Error("There's nothing to send.");
      if (!nodeId) throw new Error("No machine selected for this message.");
      if (!roomKeyReady) throw new Error("This machine isn't paired on this device — open it first so the message can be encrypted.");
      const atIso = new Date(at).toISOString();
      if (!Number.isFinite(new Date(atIso).getTime()) || new Date(atIso).getTime() <= Date.now()) {
        throw new Error("Pick a time in the future.");
      }
      const roomKey = await importRoomKey(unb64(controller.local.keys()[nodeId]!));
      const encrypted = await seal(roomKey, text.trim());
      await createAutomation(controller.local, {
        name: "Scheduled message",
        templateCiphertext: `${TEMPLATE_PREFIX}:${nodeId}:${encrypted}`,
        trigger: "schedule",
        schedule: { kind: "once", at: atIso },
        nodeLabel,
        targetKind: target,
        targetSessionId: target === "existing_session" ? state.activeSessionId ?? undefined : undefined,
        repo: target === "new_session" ? state.draftRepo ?? undefined : undefined,
        message: true,
        enabled: true,
      });
      setScheduled(`Scheduled for ${new Date(atIso).toLocaleString()} — delivered by ${node?.name ?? "your machine"}, even if the app is closed.`);
      onScheduled();
      void loadPending();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not schedule the message.");
    } finally {
      setBusy(false);
    }
  }

  async function cancelAutomation(id: string) {
    try {
      await deleteAutomation(controller.local, id);
      void loadPending();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel that message.");
    }
  }

  return (
    <Sheet title="Schedule message" onClose={onClose}>
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

        {state.activeSessionId && (
          <div className="schedule-target" role="radiogroup" aria-label="Where to send">
            <label className={`schedule-choice${target === "existing_session" ? " active" : ""}`}>
              <input
                type="radio"
                name="schedule-target"
                checked={target === "existing_session"}
                onChange={() => setTarget("existing_session")}
              />
              <span>
                <span className="schedule-choice-title">This session</span>
                <span className="schedule-choice-meta">Continue the current thread — delivered by {node?.name ?? "its machine"}</span>
              </span>
            </label>
            <label className={`schedule-choice${target === "new_session" ? " active" : ""}`}>
              <input
                type="radio"
                name="schedule-target"
                checked={target === "new_session"}
                onChange={() => setTarget("new_session")}
              />
              <span>
                <span className="schedule-choice-title">New session</span>
                <span className="schedule-choice-meta">
                  Start fresh on {state.currentNodeId ? node?.name ?? "the selected machine" : "a machine"} ·{" "}
                  {state.draftRepo ? `repo ${state.draftRepo}` : "default workspace"}
                </span>
              </span>
            </label>
          </div>
        )}

        {error && <p className="schedule-error">{error}</p>}
        {scheduled && <p className="schedule-ok">{scheduled}</p>}

        <button type="button" className="queue-action-btn active schedule-send" disabled={busy || !roomKeyReady} onClick={() => void schedule()}>
          {busy ? "Scheduling…" : "Schedule"}
        </button>

        {pending.length > 0 && (
          <div className="schedule-pending">
            <div className="schedule-pending-head">
              {pending.length} pending {pending.length === 1 ? "message" : "messages"} for this session
            </div>
            <ul className="schedule-pending-list" role="list">
              {pending.map((a) => (
                <li key={a.id} className="schedule-pending-row" role="listitem">
                  <span className="schedule-pending-when">{a.nextRunAt ? new Date(a.nextRunAt).toLocaleString() : ""}</span>
                  <button
                    type="button"
                    className="queue-action-btn icon danger"
                    onClick={() => void cancelAutomation(a.id)}
                    aria-label="Cancel scheduled message"
                    title="Cancel"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Sheet>
  );
}
