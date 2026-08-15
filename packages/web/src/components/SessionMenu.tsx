// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { controller, useAppState } from "../store/useStore.js";
import { ConfirmDialog, RenameDialog } from "./AppDialog.js";
import { ForkSheet } from "./ForkSheet.js";
import { sessionReferenceText, writeClipboard } from "../clipboard.js";
import { routePath } from "../router.js";
import { useModalEscape } from "../modalStack.js";

// See SessionList's identical constant/rationale.
const PR_BUSY_TIMEOUT_MS = 20000;

// Copyable `bivy resume <id>` command surfaced by "Continue in terminal
// locally". Run on any machine with the bivy CLI (same account), it relaunches
// the session through the agent's native resume (`claude --resume`, `codex
// resume`) or points back at the web app — the "take this conversation with
// you" sibling of "Continue in terminal" (which attaches the live TUI here).
function ResumeCommandDialog({
  sessionId,
  name,
  onCancel,
}: {
  sessionId: string;
  name: string;
  onCancel: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useModalEscape(onCancel);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const titleId = useId();
  const copy = async () => {
    if (!(await writeClipboard(`bivy resume ${sessionId}`))) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  };
  return createPortal(
    <div className="app-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="app-dialog-backdrop" onClick={onCancel} />
      <div className="app-dialog-body">
        <h3 id={titleId}>Continue in terminal locally</h3>
        <p>
          Run this in a terminal on any machine with the bivy CLI to pick up “{name}”
          outside the web app:
        </p>
        <div className="repo-connect-command resume-command">
          <code>{`bivy resume ${sessionId}`}</code>
          <button
            type="button"
            className={`repo-connect-copy${copied ? " is-copied" : ""}`}
            onClick={copy}
            aria-label={copied ? "Command copied" : "Copy resume command"}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="repo-connect-alt">
          It resumes the same conversation — saved sessions relaunch via the agent&rsquo;s native
          resume where supported, otherwise it opens the session here in the web app.
        </p>
        <div className="app-dialog-actions">
          <button className="btn" onClick={onCancel}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

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
  auditHealth,
  eventLogHealth,
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
  auditHealth?: {
    storage: "healthy" | "missing" | "corrupt" | "unreadable";
    writes: "healthy" | "unknown" | "degraded";
    failedWrites: number;
    corruptLines: number;
  };
  eventLogHealth?: { state: "healthy" | "degraded"; operation?: "read" | "parse" | "append" | "rewrite"; at?: number };
  /** "Continue in terminal": hand this session to the runtime's interactive TUI.
   *  Undefined (item hidden) when the runtime lacks `interactiveTui` or the node
   *  is offline — the reverse of the terminal's "continue in chat". */
  onContinueInTerminal?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [prBusy, setPrBusy] = useState(false);
  const { presentation: { prResult, error } } = useAppState();
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
      {resumeOpen && <ResumeCommandDialog sessionId={sessionId} name={name} onCancel={() => setResumeOpen(false)} />}
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
        <div className="menu session-actions-menu" role="menu">
          {auditHealth && (["corrupt", "unreadable"].includes(auditHealth.storage) || auditHealth.writes === "degraded") && (
            <div className="session-actions-audit-warning" role="status">
              <strong>Audit evidence degraded</strong>
              <span>{auditHealth.writes === "degraded" ? `${auditHealth.failedWrites} audit write${auditHealth.failedWrites === 1 ? "" : "s"} failed.` : `Audit storage is ${auditHealth.storage}.`}</span>
            </div>
          )}
          {eventLogHealth?.state === "degraded" && (
            <div className="session-actions-audit-warning" role="status">
              <strong>Session history persistence degraded</strong>
              <span>The last {eventLogHealth.operation ?? "storage"} operation failed. History may be incomplete.</span>
            </div>
          )}
          <button className="menu-item session-actions-item" role="menuitem" onClick={copyReference} disabled={prBusy}>
            Copy session reference
          </button>
          <button className="menu-item session-actions-item" role="menuitem" onClick={rename} disabled={prBusy}>
            Rename
          </button>
          <button className="menu-item session-actions-item" role="menuitem" onClick={() => { close(); setForkOpen(true); }} disabled={prBusy}>
            Fork / move…
          </button>
          {onContinueInTerminal && (
            <button
              className="menu-item session-actions-item"
              role="menuitem"
              onClick={() => { close(); onContinueInTerminal(); }}
              title="Open this session in the agent's interactive terminal (resumes the same conversation)"
            >
              Continue in terminal
            </button>
          )}
          <button
            className="menu-item session-actions-item"
            role="menuitem"
            onClick={() => { close(); setResumeOpen(true); }}
            disabled={prBusy}
            title="Copy a `bivy resume` command to run on your own machine"
          >
            Continue in terminal locally…
          </button>
          {isRepo && (
            <button className="menu-item session-actions-item" role="menuitem" onClick={refreshPrStatus} disabled={prBusy}>
              {prBusy ? "Checking GitHub status…" : "Update GitHub status"}
            </button>
          )}
          <button className="menu-item session-actions-item danger" role="menuitem" onClick={del} disabled={prBusy}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
