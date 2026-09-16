// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Destination picker for a share-sheet landing (see shareTarget.ts): shared
// text can start a fresh session (the default) or continue an existing one.
// Dismissing the sheet — backdrop, Escape, swipe — falls back to the default
// so the shared text is never dropped.

import { useRef } from "react";
import type { SessionSummary } from "@bivy/core";
import { Sheet, PickerItem } from "./Sheet.js";

/** Rows shown before the list stops being scannable on a phone sheet. */
const MAX_RECENT = 8;

/** Newest-first sessions that can actually receive a draft right now —
 *  provisioning placeholders can't. Exported for tests. */
export function shareDestinations(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions
    .filter((session) => !session.pendingLaunch)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, MAX_RECENT);
}

function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

export function ShareDestinationSheet({
  text,
  sessions,
  onDeliver,
}: {
  /** The shared payload, already composed into draft-ready text. */
  text: string;
  sessions: readonly SessionSummary[];
  /** null = new session (also the dismiss fallback); otherwise the picked session. */
  onDeliver: (target: SessionSummary | null) => void;
}) {
  const recent = shareDestinations(sessions);
  // Deliver exactly once. A pick delivers immediately (the parent then
  // unmounts the sheet); the Sheet's own onClose — which fires for EVERY
  // close, including the one a pick triggers — only delivers the fallback
  // when nothing was picked (backdrop / Escape / swipe dismissal).
  const delivered = useRef(false);
  const deliver = (target: SessionSummary | null) => {
    if (delivered.current) return;
    delivered.current = true;
    onDeliver(target);
  };
  return (
    <Sheet
      title="Send shared text to…"
      ariaLabel="Choose where to send the shared text"
      onClose={() => deliver(null)}
      autoFocusSearch={false}
    >
      <p className="muted small">“{previewOf(text)}”</p>
      <div className="picker-list">
        <PickerItem
          active
          title="New session"
          meta="Start fresh with the shared text"
          onClick={() => deliver(null)}
        />
        {recent.map((session) => (
          <PickerItem
            key={session.sessionId}
            title={session.name}
            meta={[session.agentName, session.branch].filter(Boolean).join(" · ") || undefined}
            onClick={() => deliver(session)}
          />
        ))}
      </div>
    </Sheet>
  );
}
