// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { AppState } from "@bivy/core";
import { Spinner } from "./Spinner.js";
import { useModalEscape } from "../modalStack.js";

/** App-owned, not session-owned: survives node switches and sheet dismissal.
 * No history sentinel: completion navigates without an asynchronous Back race.
 * The native modal makes the underlying app inert and keeps keyboard focus in.
 */
export function ForkProgressDialog({ progress, onClose }: {
  progress: NonNullable<AppState["presentation"]["forkProgress"]>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const messageId = useId();
  const busy = progress.status === "working";
  useModalEscape(() => { if (!busy) onClose(); });
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return createPortal(
    <dialog ref={ref} tabIndex={-1} className="app-dialog-body fork-progress-dialog" aria-labelledby={titleId} aria-describedby={messageId}
      onKeyDown={(event) => {
        // A progress-only dialog has no controls; keep Tab on its content
        // rather than handing focus to browser chrome while work is pending.
        if (busy && event.key === "Tab") { event.preventDefault(); ref.current?.focus(); }
      }}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <h3 id={titleId} className="run-sheet-title">{busy && <Spinner size="sm" />}{busy ? "Forking session" : "Fork needs attention"}</h3>
      <p id={messageId} role={busy ? "status" : "alert"}>{progress.message}</p>
      {busy ? <p>You’ll be taken to the new session when it’s ready.</p> : (
        <div className="app-dialog-actions"><button className="btn primary" onClick={onClose}>Close</button></div>
      )}
    </dialog>,
    document.body,
  );
}
