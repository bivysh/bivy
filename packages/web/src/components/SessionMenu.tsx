// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import type { PrRef } from "@bivy/core";
import { controller, useAppState } from "../store/useStore.js";
import { ConfirmDialog, RenameDialog } from "./AppDialog.js";
import { StatsPanel } from "./StatsPanel.js";
import { SessionSettings } from "./SessionSettings.js";
import { ForkSheet } from "./ForkSheet.js";

/** Human-facing label for a PR link in the menu — mirrors SessionList's own
 *  `prActionLabel` (kept local rather than shared: trivial, and the two
 *  aren't guaranteed to want to stay identical forever). */
function prActionLabel(pr: PrRef): string {
  const num = pr.number ? ` #${pr.number}` : "";
  const state = pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : "open";
  return `Pull request${num} (${state})`;
}

// See SessionList's identical constant/rationale.
const PR_BUSY_TIMEOUT_MS = 20000;

/**
 * Header dot-menu for the active session: rename, its pull request(s) (repo
 * sessions), delete. Mirrors SessionList's row action sheet — including the
 * PR affordance (every PR as a direct link, plus "Update GitHub status" to
 * re-check on demand) — as an inline popover anchored to the header — the
 * header isn't a scroll container, so it doesn't need the bottom-sheet escape
 * hatch that the list row does.
 */
export function SessionMenu({
  sessionId,
  name,
  isRepo,
  prs,
  collapsed,
  onToggleCollapsed,
}: {
  sessionId: string;
  name: string;
  isRepo: boolean;
  prs?: PrRef[];
  /** Focus view: hide interim messages and tool use, leaving the conversation. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
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
  const stats = () => {
    close();
    setStatsOpen(true);
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
      {statsOpen && <StatsPanel onClose={() => setStatsOpen(false)} />}
      {sessionSettingsOpen && <SessionSettings onClose={() => setSessionSettingsOpen(false)} />}
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
          <button
            className="session-actions-item"
            role="menuitemcheckbox"
            aria-checked={collapsed}
            onClick={() => {
              close();
              onToggleCollapsed();
            }}
          >
            {collapsed ? "Show all messages" : "Focus view — hide tool use"}
          </button>
          <button className="session-actions-item" role="menuitem" onClick={stats}>
            Node stats
          </button>
          <button
            className="session-actions-item"
            role="menuitem"
            onClick={() => { close(); setSessionSettingsOpen(true); }}
          >
            Session settings
          </button>
          <button className="session-actions-item" role="menuitem" onClick={rename} disabled={prBusy}>
            Rename
          </button>
          <button className="session-actions-item" role="menuitem" onClick={() => { close(); setForkOpen(true); }} disabled={prBusy}>
            Fork / move…
          </button>
          {(prs ?? []).map((pr) => (
            <a key={pr.url} className="session-actions-item" role="menuitem" href={pr.url} target="_blank" rel="noopener" onClick={close}>
              {prActionLabel(pr)}
            </a>
          ))}
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
