// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Full session-window shown in place of the chat when the active session is
 * driven by its interactive TUI (single writer — see store.ts's `tuiSessions`).
 * Where the old design dropped a lock banner under a dead composer, this tells
 * the user *why* the chat is paused up front, and hands them exactly the two
 * ways forward: jump to the running terminal, or take the session back into
 * chat ("Use chat" = terminal.close.tui → the node SIGTERMs the TUI and
 * broadcasts `terminal.tui {active:false}`, unlocking the composer).
 */
export function TuiLockedView({
  sessionName,
  nodeLabel,
  online,
  onOpenTerminal,
  onUseChat,
}: {
  sessionName: string;
  nodeLabel?: string;
  online: boolean;
  onOpenTerminal: () => void;
  onUseChat: () => void;
}) {
  return (
    <div className="tui-locked" role="status" aria-live="polite">
      <div className="tui-locked-card">
        <span className="tui-locked-icon" aria-hidden>
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="m7 9 3 3-3 3" />
            <path d="M13 15h4" />
          </svg>
        </span>
        <h2 className="tui-locked-title">This session is running in the terminal.</h2>
        <p className="tui-locked-sub">
          <span className="tui-locked-name">“{sessionName}”</span> is open in the interactive terminal
          {nodeLabel ? (
            <>
              {" "}on <span className="tui-locked-node">{nodeLabel}</span>
            </>
          ) : null}
          . Chat is paused while it&rsquo;s open &mdash; open the terminal to watch it, or take it over to
          message it here.
        </p>
        <div className="tui-locked-actions">
          <button type="button" className="btn" onClick={onOpenTerminal} disabled={!online}>
            Open terminal
          </button>
          <button type="button" className="btn primary" onClick={onUseChat} disabled={!online}>
            Use chat
          </button>
        </div>
        {!online && <p className="tui-locked-hint">Reconnect to the machine to open the terminal or take over in chat.</p>}
      </div>
    </div>
  );
}
