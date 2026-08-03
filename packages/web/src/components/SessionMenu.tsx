// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import { controller, useAppState } from "../store/useStore.js";
import { ConfirmDialog, RenameDialog } from "./AppDialog.js";
import { ForkSheet } from "./ForkSheet.js";
import { sessionReferenceText, writeClipboard } from "../clipboard.js";
import { routePath } from "../router.js";

// See SessionList's identical constant/rationale.
const PR_BUSY_TIMEOUT_MS = 20000;

/**
 * Header dot-menu for the active session. Rendered as an inline popover
 * anchored to the header — the header isn't a scroll container, so it doesn't
 * need the bottom-sheet escape hatch that the list row does.
 */
export function SessionMenu({
  sessionId,
  name,
  isRepo,
  node,
  agent,
  workspace,
  worktree,
  branch,
  sessionFile,
  onOpenTerminal,
  onContinueInTerminal,
}: {
  sessionId: string;
  name: string;
  isRepo: boolean;
  node?: string;
  agent?: string;
  workspace?: string;
  worktree?: string;
  branch?: string;
  sessionFile?: string;
  /** Open a terminal attached to this session. Undefined (item hidden) when the
   *  node is offline. */
  onOpenTerminal?: () => void;
  /** "Continue in terminal": hand this session to the runtime's interactive TUI.
   *  Undefined (item hidden) when the runtime lacks `interactiveTui` or the node
   *  is offline — the reverse of the terminal's "continue in chat". */
  onContinueInTerminal?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [prBusy, setPrBusy] = useState(false);
  const { prResult, error } = useAppState();
  const prBusyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!prBusy) return;
    setPrBusy(false);
    setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to either changing, not to prBusy itself
  }, [prResult, error]);

  useEffect(() => () => { if (prBusyTimer.current) clearTimeout(prBusyTimer.current); }, []);

  const close = () => setOpen(false);
  const rename = () => {
    close();
    setRenaming(true);
  };
  const del = () => {
    close();
    setDeleting(true);
  };
  const copyReference = async () => {
    close();
    const url = `${location.origin}${routePath({ kind: "session", id: sessionId })}`;
    const copied = await writeClipboard(sessionReferenceText({
      url,
      sessionId,
      node,
      agent,
      workspace,
      worktree,
      branch,
      sessionFile,
    }));
    if (copied) controller.store.setNotice("Session reference copied");
    else controller.store.setError("Couldn't copy the session reference");
  };
  const refreshPrStatus = () => {
    setPrBusy(true);
    controller.refreshPrStatus(sessionId);
    if (prBusyTimer.current) clearTimeout(prBusyTimer.current);
    prBusyTimer.current = setTimeout(() => { setPrBusy(false); setOpen(false); }, PR_BUSY_TIMEOUT_MS);
  };

  return (
    <div className="session-actions-wrap" ref={ref}>
      <button
        className="session-actions-btn"
        aria-label="Session actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⋯
      </button>
      {renaming && (
        <RenameDialog
          title="Rename session"
          initialValue={name}
          onCancel={() => setRenaming(false)}
          onSave={(next) => { controller.renameSession(sessionId, next); setRenaming(false); }}
        />
      )}
      {forkOpen && <ForkSheet sessionId={sessionId} onClose={() => setForkOpen(false)} />}
      {deleting && (
        <ConfirmDialog
          title="Delete session?"
          message={`Delete “${name}”? This can't be undone.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleting(false)}
          onConfirm={() => { controller.deleteSession(sessionId); setDeleting(false); }}
        />
      )}
      {open && (
        <div className="session-actions-menu" role="menu">
          {onOpenTerminal && (
            <button
              className="session-actions-item"
              role="menuitem"
              onClick={() => { close(); onOpenTerminal(); }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="m7 9 3 3-3 3" />
                <path d="M13 15h4" />
              </svg>
              Terminal
            </button>
          )}
          <button className="session-actions-item" role="menuitem" onClick={copyReference} disabled={prBusy}>
            Copy session reference
          </button>
          <button className="session-actions-item" role="menuitem" onClick={rename} disabled={prBusy}>
            Rename
          </button>
          <button className="session-actions-item" role="menuitem" onClick={() => { close(); setForkOpen(true); }} disabled={prBusy}>
            Fork / move…
          </button>
          {onContinueInTerminal && (
            <button
              className="session-actions-item"
              role="menuitem"
              onClick={() => { close(); onContinueInTerminal(); }}
              title="Open this session in the agent's interactive terminal (resumes the same conversation)"
            >
              Continue in terminal
            </button>
          )}
          {isRepo && (
            <button className="session-actions-item" role="menuitem" onClick={refreshPrStatus} disabled={prBusy}>
              {prBusy ? "Checking GitHub status…" : "Update GitHub status"}
            </button>
          )}
          <button className="session-actions-item danger" role="menuitem" onClick={del} disabled={prBusy}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
