// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState, useSyncExternalStore } from "react";
import { onUpdateAvailable, reloadForUpdate } from "../pwa.js";
import { getPwaLifecycleState, subscribePwaLifecycle, updateBlockers } from "../pwaLifecycle.js";

/** A waiting worker never activates while user work could be displaced. */
export function UpdatePrompt() {
  const [show, setShow] = useState(false);
  const lifecycle = useSyncExternalStore(subscribePwaLifecycle, getPwaLifecycleState);
  useEffect(() => onUpdateAvailable(setShow), []);
  if (!show) return null;
  const blockers = updateBlockers(lifecycle);
  return (
    <div className="update-toast" role="status">
      <span>
        <strong>A Bivy update is ready.</strong>{" "}
        {blockers.length
          ? `Reload is available after ${blockers.join(", ")}.`
          : "Draft text and attachment names are stored in this browser; cached transcripts remain when browser storage is available. File contents must be re-selected."}
      </span>
      <button className="btn ghost" onClick={() => setShow(false)}>Later</button>
      <button className="btn primary" onClick={reloadForUpdate} disabled={blockers.length > 0} aria-disabled={blockers.length > 0}>
        Reload safely
      </button>
    </div>
  );
}
