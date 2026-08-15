// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The visible queue of follow-up prompts held back while a session is busy
// (or while earlier follow-ups are still waiting) — issue #154. Renders just
// above the composer so queued text, its delivery order, and its state
// (queued/sending/failed) are never invisible the way a straight-through send
// into a busy session used to be. Also carries the session's *scheduled*
// messages (split Send → ScheduleSheet): the control-plane automation
// delivers those on its own timer, so they sit here as timestamped rows that
// can be cancelled (✕) before they fire, or re-timed (✎ → inline datetime
// field) by updating the automation in place — rather than only living inside
// the schedule sheet. Edit/reorder/remove/send-next for the *queued* rows are
// all local, synchronous store mutations (see AppController's queued-follow-ups
// API) — they work even while offline, since nothing here is a network round
// trip until an item is actually dispatched. Scheduled rows are the one
// exception: cancel and re-time talk to the control plane.
import { useState } from "react";
import type { PendingFollowup, PromptAttachment } from "@bivy/core";
import { controller } from "../store/useStore.js";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** When a scheduled message will be sent, e.g. "Sends today at 2:05 PM" or
 *  "Sends Mon, Aug 10 at 2:05 PM" — local time, human-friendly. */
function formatSendTime(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay
    ? `Sends today at ${time}`
    : `Sends ${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}

function statusLabel(item: PendingFollowup, position: number): string {
  if (item.status === "scheduled") return item.scheduledAt != null ? formatSendTime(item.scheduledAt) : "Scheduled";
  if (item.status === "sending") return "Sending…";
  if (item.status === "failed") return "Failed — will retry";
  const base = `Queued · #${position + 1}`;
  // Account/relay mode: mirrored as a scheduled message on the control plane,
  // so it sends even if this app closes before the turn ends.
  return item.scheduledAutomationId ? `${base} · sends on close` : base;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** A `<input type="datetime-local">` value for a Date (local wall-clock). */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One queued item, either its resting display row or an inline editor. */
function FollowupRow({
  sessionId,
  item,
  position,
  count,
  canSteer,
  busy,
  onError,
}: {
  sessionId: string;
  item: PendingFollowup;
  position: number;
  count: number;
  canSteer: boolean;
  busy: boolean;
  onError?: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(item.text);
  const [draftAttachments, setDraftAttachments] = useState<PromptAttachment[]>(item.attachments ?? []);
  const [editingTime, setEditingTime] = useState(false);
  const [draftAt, setDraftAt] = useState(() => (item.scheduledAt != null ? toLocalInput(new Date(item.scheduledAt)) : toLocalInput(new Date())));
  const scheduled = item.status === "scheduled";
  // Scheduled rows are delivered by their automation on their own timer — the
  // text can't change (it's already sealed), only the fire time, via the inline
  // editor; nothing else (reorder/send-next) applies.
  const locked = item.status !== "queued" && !scheduled;

  function startEdit() {
    if (locked) return;
    setDraftText(item.text);
    setDraftAttachments(item.attachments ?? []);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
  }

  function save() {
    const text = draftText.trim();
    if (!text && draftAttachments.length === 0) {
      onError?.("A follow-up needs some text or an attachment.");
      return;
    }
    const result = controller.editFollowup(sessionId, item.id, { text, attachments: draftAttachments.length ? draftAttachments : undefined }, item.version);
    if (!result.ok) {
      const message =
        result.reason === "stale"
          ? "This follow-up changed elsewhere — refresh and try again."
          : result.reason === "not_queued"
            ? "This follow-up is already sending — it can no longer be edited."
            : "This follow-up is gone — it may have already been sent.";
      onError?.(message);
    }
    setEditing(false);
  }

  function removeAttachment(i: number) {
    setDraftAttachments((prev) => prev.filter((_, idx) => idx !== i));
  }

  function startEditTime() {
    if (!scheduled) return;
    setDraftAt(item.scheduledAt != null ? toLocalInput(new Date(item.scheduledAt)) : toLocalInput(new Date()));
    setEditingTime(true);
  }

  function cancelEditTime() {
    setEditingTime(false);
  }

  function saveTime() {
    const when = new Date(draftAt);
    if (!Number.isFinite(when.getTime()) || when.getTime() <= Date.now()) {
      onError?.("Pick a time in the future.");
      return;
    }
    void (async () => {
      const err = await controller.editScheduledFollowup(sessionId, item.id, when);
      if (err) onError?.(err);
      else setEditingTime(false);
    })();
  }

  const sendNowLabel = busy && canSteer ? "Steer now" : "Send next";

  return (
    <div className={`card followup-card${editing || editingTime ? " editing" : ""}${locked ? " locked" : ""}`} data-tone="muted" role="listitem">
      {editing || editingTime ? (
        <div className="followup-edit">
          {editingTime ? (
            <label className="schedule-field">
              <span className="schedule-label">Send at</span>
              <input
                type="datetime-local"
                className="field"
                value={draftAt}
                min={toLocalInput(new Date())}
                autoFocus
                onChange={(e) => setDraftAt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEditTime();
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    saveTime();
                  }
                }}
              />
            </label>
          ) : (
            <>
              <textarea
                className="field followup-edit-input"
                value={draftText}
                autoFocus
                rows={2}
                onChange={(e) => setDraftText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEdit();
                  } else if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    save();
                  }
                }}
              />
              {draftAttachments.length > 0 && (
                <div className="attach-chips">
                  {draftAttachments.map((a, i) => (
                    <span key={`${a.name}-${i}`} className="attach-chip" title={a.name}>
                      <span className="attach-glyph">{a.kind === "image" ? "🖼" : "📄"}</span>
                      <span className="attach-name">{a.name}</span>
                      <button type="button" className="attach-remove" onClick={() => removeAttachment(i)} aria-label={`Remove ${a.name}`}>
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
          <div className="followup-edit-actions">
            <button type="button" className="queue-action-btn" onClick={editingTime ? cancelEditTime : cancelEdit}>
              Cancel
            </button>
            <button type="button" className="queue-action-btn active" onClick={editingTime ? saveTime : save}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <div
          className="followup-card-row"
          tabIndex={locked ? -1 : 0}
          role="group"
          aria-label={scheduled ? "Scheduled message" : `Follow-up ${position + 1} of ${count}`}
          onKeyDown={(e) => {
            if (locked) return;
            if (scheduled) {
              // Cancel via keyboard, like the queued rows' remove shortcut; Enter
              // opens the inline time editor (the queued rows' Enter opens the
              // text editor).
              if (e.key === "Enter") {
                e.preventDefault();
                startEditTime();
              } else if (e.key === "Delete" || e.key === "Backspace") {
                e.preventDefault();
                controller.removeFollowup(sessionId, item.id);
              }
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              controller.reorderFollowup(sessionId, item.id, position - 1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              controller.reorderFollowup(sessionId, item.id, position + 1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              startEdit();
            } else if (e.key === "Delete" || e.key === "Backspace") {
              e.preventDefault();
              controller.removeFollowup(sessionId, item.id);
            }
          }}
        >
          {!scheduled && (
            <div className="followup-reorder">
              <button
                type="button"
                className="queue-action-btn icon"
                disabled={locked || position === 0}
                onClick={() => controller.reorderFollowup(sessionId, item.id, position - 1)}
                aria-label="Move earlier"
                title="Move earlier"
              >
                ▲
              </button>
              <button
                type="button"
                className="queue-action-btn icon"
                disabled={locked || position === count - 1}
                onClick={() => controller.reorderFollowup(sessionId, item.id, position + 1)}
                aria-label="Move later"
                title="Move later"
              >
                ▼
              </button>
            </div>
          )}
          <div className="followup-body">
            <div className="followup-status">{statusLabel(item, position)}</div>
            <div className="followup-text">{item.text || "(attachment only)"}</div>
            {item.attachments && item.attachments.length > 0 && (
              <div className="followup-attachments">
                {item.attachments.map((a, i) => (
                  <span key={`${a.name}-${i}`} className="attach-chip" title={a.name}>
                    <span className="attach-glyph">{a.kind === "image" ? "🖼" : "📄"}</span>
                    <span className="attach-name">{a.name}</span>
                    <span className="attach-size">{fmtBytes(a.size)}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="followup-card-actions">
            {scheduled ? (
              <>
                <button
                  type="button"
                  className="queue-action-btn icon"
                  onClick={startEditTime}
                  aria-label="Change scheduled time"
                  title="Change time"
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="queue-action-btn icon danger"
                  onClick={() => controller.removeFollowup(sessionId, item.id)}
                  aria-label="Cancel scheduled message"
                  title="Cancel"
                >
                  ✕
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="queue-action-btn icon"
                  disabled={locked}
                  onClick={startEdit}
                  aria-label="Edit follow-up"
                  title="Edit"
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="queue-action-btn icon danger"
                  disabled={locked}
                  onClick={() => controller.removeFollowup(sessionId, item.id)}
                  aria-label="Remove follow-up"
                  title="Remove"
                >
                  ✕
                </button>
                <button
                  type="button"
                  className="queue-action-btn"
                  disabled={locked}
                  onClick={() => controller.sendFollowupNow(sessionId, item.id)}
                  title={sendNowLabel}
                >
                  {sendNowLabel}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function FollowupQueue({
  sessionId,
  items,
  canSteer,
  busy,
  onError,
}: {
  sessionId: string;
  items: PendingFollowup[];
  canSteer: boolean;
  busy: boolean;
  onError?: (message: string) => void;
}) {
  if (!items.length) return null;
  const queuedCount = items.filter((i) => i.status === "queued").length;
  const scheduledCount = items.filter((i) => i.status === "scheduled").length;
  const head =
    queuedCount > 0
      ? `${queuedCount} follow-up${queuedCount > 1 ? "s" : ""} queued${scheduledCount ? ` · ${scheduledCount} scheduled` : ""}`
      : `${scheduledCount} scheduled message${scheduledCount > 1 ? "s" : ""}`;
  return (
    <div className="followup-queue">
      <div className="followup-queue-head">
        <span>{head}</span>
      </div>
      <div className="followup-list" role="list">
        {items.map((item, i) => (
          <FollowupRow
            key={item.id}
            sessionId={sessionId}
            item={item}
            position={i}
            count={items.length}
            canSteer={canSteer}
            busy={busy}
            onError={onError}
          />
        ))}
      </div>
    </div>
  );
}
