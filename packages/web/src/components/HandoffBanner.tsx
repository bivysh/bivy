// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useState } from "react";
import { thisDevice } from "../device.js";
import { handoffFor, type Handoff } from "../handoff.js";
import { useSessionPresence } from "../useSessionPresence.js";
import { relTime } from "./ChangesCard.js";

/** First line of a draft, trimmed for a one-line preview. */
function preview(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** The handoff note itself, from a decided Handoff (see handoff.ts). */
export function HandoffNote({ handoff, onContinue }: { handoff: Handoff; onContinue: () => void }) {
  return (
    <div className="banner handoff-banner" data-tone="neutral" role="status">
      <span className="banner-text">
        <strong>Unsent draft from {handoff.from} · {relTime(handoff.at)}</strong>
        <span className="handoff-preview">{preview(handoff.text)}</span>
      </span>
      <button type="button" className="btn sm banner-action" onClick={onContinue}>
        Continue draft
      </button>
    </div>
  );
}

/**
 * Shown above the composer when another device left an unsent draft on this
 * session; Continue draft moves it into this composer. It never blocks
 * anything, since any device can send at any time.
 */
export function HandoffBanner({ sessionId, composerEmpty, onUseDraft }: {
  sessionId: string;
  composerEmpty: boolean;
  onUseDraft: (text: string) => void;
}) {
  const presence = useSessionPresence(sessionId);
  const [dismissed, setDismissed] = useState<string>("");
  const handoff = handoffFor(presence, thisDevice(), composerEmpty, Date.now());
  if (!handoff) return null;
  // Dismissal is per draft moment: a newer draft elsewhere shows it again.
  const key = `${sessionId}:${handoff.at}`;
  if (dismissed === key) return null;
  return (
    <HandoffNote
      handoff={handoff}
      onContinue={() => {
        onUseDraft(handoff.text);
        setDismissed(key);
      }}
    />
  );
}
