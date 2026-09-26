// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useState } from "react";
import type { StandbyCopy } from "../standby.js";

/**
 * Shown above the composer on a machine that holds only a standby copy of the
 * session. With the owner offline, Continue here promotes the copy so the
 * session keeps going on this machine. With the owner online, the live session
 * is over there, so this offers to open it there instead.
 */
export function StandbyNotice({ standby, onContinueHere, onOpenOnOwner }: {
  standby: StandbyCopy;
  onContinueHere: () => Promise<void>;
  onOpenOnOwner: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (standby.ownerOnline) {
    return (
      <div className="banner handoff-banner" data-tone="neutral" role="status">
        <span className="banner-text"><strong>Standby copy. This session is live on {standby.ownerName}.</strong></span>
        <button type="button" className="btn sm banner-action" onClick={onOpenOnOwner}>Open on {standby.ownerName}</button>
      </div>
    );
  }
  return (
    <div className="banner handoff-banner" data-tone="warn" role="status">
      <span className="banner-text">
        <strong>{standby.ownerName} is offline.</strong>
        <span>This machine has a standby copy, up to its last finished turn.</span>
      </span>
      <button
        type="button"
        className="btn sm banner-action"
        disabled={busy}
        aria-busy={busy}
        onClick={() => { setBusy(true); void onContinueHere().finally(() => setBusy(false)); }}
      >
        {busy ? "Continuing…" : "Continue here"}
      </button>
    </div>
  );
}
