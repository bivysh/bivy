// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState, useSyncExternalStore } from "react";
import { onUpdateAvailable, reloadForUpdate } from "../pwa.js";
import { getPwaLifecycleState, subscribePwaLifecycle, updateBlockers } from "../pwaLifecycle.js";
import { Toast } from "./Toast.js";

/** A waiting worker never activates while user work could be displaced. */
export function UpdatePrompt() {
  const [show, setShow] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifecycle = useSyncExternalStore(subscribePwaLifecycle, getPwaLifecycleState);
  useEffect(() => onUpdateAvailable(setShow), []);
  if (!show) return null;
  const blockers = updateBlockers(lifecycle);
  const reload = async () => {
    if (updating) return;
    setUpdating(true);
    setError(null);
    try {
      await reloadForUpdate();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Update failed. Please try Reload again.");
    } finally {
      setUpdating(false);
    }
  };
  return (
    <Toast tone="accent" className="update-toast" role="status">
      <span>
        <strong>A Bivy update is ready.</strong>{" "}
        {blockers.length
          ? `Reload is available after ${blockers.join(", ")}.`
          : "Draft text and attachment names are stored in this browser; cached transcripts remain when browser storage is available. File contents must be re-selected."}
      </span>
      {error && <span role="alert">{error}</span>}
      <div className="update-toast-actions">
        <button className="btn ghost" onClick={() => setShow(false)} disabled={updating}>Later</button>
        <button className="btn primary" onClick={reload} disabled={updating || blockers.length > 0} aria-disabled={updating || blockers.length > 0}>
          {updating ? "Updating…" : "Reload"}
        </button>
      </div>
    </Toast>
  );
}
