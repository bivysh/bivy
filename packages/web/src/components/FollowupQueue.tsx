// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The visible queue of follow-up prompts held back while a session is busy
// (or while earlier follow-ups are still waiting) — issue #154. Renders just
// above the composer so queued text, its delivery order, and its state
// (queued/sending/failed) are never invisible the way a straight-through send
// into a busy session used to be. Edit/reorder/remove/send-next are all local,
// synchronous store mutations (see AppController's queued-follow-ups API) —
// they work even while offline, since nothing here is a network round trip
// until an item is actually dispatched.
import { useState } from "react";
import type { PendingFollowup, PromptAttachment } from "@bivy/core";
import { controller } from "../store/useStore.js";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function statusLabel(item: PendingFollowup, position: number): string {
  if (item.status === "sending") return "Sending…";
  if (item.status === "failed") return "Failed — will retry";
  return `Queued · #${position + 1}`;
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
  const locked = item.status !== "queued";

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

  const sendNowLabel = busy && canSteer ? "Steer now" : "Send next";

  return (
    <div className={`followup-card${editing ? " editing" : ""}${locked ? " locked" : ""}`} role="listitem">
      {editing ? (
        <div className="followup-edit">
          <textarea
            className="followup-edit-input"
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
          <div className="followup-edit-actions">
            <button type="button" className="queue-action-btn" onClick={cancelEdit}>
              Cancel
            </button>
            <button type="button" className="queue-action-btn active" onClick={save}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <div
          className="followup-card-row"
          tabIndex={locked ? -1 : 0}
          role="group"
          aria-label={`Follow-up ${position + 1} of ${count}`}
          onKeyDown={(e) => {
            if (locked) return;
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
  return (
    <div className="followup-queue">
      <div className="followup-queue-head">
        <span>
          {items.length} follow-up{items.length > 1 ? "s" : ""} queued
        </span>
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
