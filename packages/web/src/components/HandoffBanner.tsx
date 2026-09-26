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
  const where = handoff.kind === "driver" && handoff.via === "terminal" && !/terminal/i.test(handoff.from) ? `the terminal on ${handoff.from}` : handoff.from;
  return (
    <div className="banner handoff-banner" data-tone="neutral" role="status">
      <span className="banner-text">
        {handoff.kind === "draft" ? (
          <>
            <strong>Unsent draft from {handoff.from} · {relTime(handoff.at)}</strong>
            <span className="handoff-preview">{preview(handoff.text)}</span>
          </>
        ) : (
          <strong>Last active on {where} · {relTime(handoff.at)}</strong>
        )}
      </span>
      <button type="button" className="btn sm banner-action" onClick={onContinue}>
        {handoff.kind === "draft" ? "Continue draft" : "Continue here"}
      </button>
    </div>
  );
}

/**
 * "You were just on your Mac": shown above the composer when another device
 * drove this session recently, or left an unsent draft. Continue draft moves
 * that draft into this composer; Continue here just clears the note. It never
 * blocks anything, since whoever sends next is the driver.
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
  // Dismissal is per handoff moment: new activity elsewhere shows it again.
  const key = `${sessionId}:${handoff.kind}:${handoff.at}`;
  if (dismissed === key) return null;
  return (
    <HandoffNote
      handoff={handoff}
      onContinue={() => {
        if (handoff.kind === "draft") onUseDraft(handoff.text);
        setDismissed(key);
      }}
    />
  );
}
