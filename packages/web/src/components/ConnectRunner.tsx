// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import type { AccountNode } from "@bivy/core";
import { writeClipboard } from "../clipboard.js";

const INSTALL_CMD = "curl -fsSL https://bivy.sh/install.sh | bash";

/**
 * The "no runner connected" onboarding screen shown on a fresh session before a
 * node is selected. Presents the two ways to get a runner online — install on
 * your own machine, or (when enabled) spin up an ephemeral cloud server — plus,
 * when the account already has enrolled nodes, a list of them: picking one opens
 * a new session on that node. A live "waiting to connect" indicator sits at the
 * bottom.
 */
export function ConnectRunner({
  nodes,
  ephemeralEnabled,
  onPickNode,
  onEphemeral,
  onRefresh,
}: {
  nodes: AccountNode[];
  ephemeralEnabled: boolean;
  onPickNode: (nodeId: string) => void;
  onEphemeral: () => void;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  // Ephemeral machines (id `eph-…`) live in their own launcher, not the
  // persistent node list — mirror the node switcher so a booted ephemeral runner
  // isn't offered here as if it were a regular enrolled node.
  const persistentNodes = nodes.filter((n) => !n.id.startsWith("eph-"));

  const copyCommand = async () => {
    const ok = await writeClipboard(INSTALL_CMD);
    if (!ok) return;
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1800);
  };

  return (
    <section className="connect-runner" role="status" aria-live="polite">
      <div className="connect-hero">
        <span className="connect-hero-icon" aria-hidden>
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="8" rx="2" />
            <rect x="3" y="14" width="18" height="6" rx="2" />
            <path d="M7 8h.01M7 17h.01" />
          </svg>
        </span>
        <div className="connect-kicker">No runner connected yet</div>
        <h2 className="connect-title">Connect a computer to get going</h2>
        <p className="connect-sub">
          Bivy runs agents on machines you control. Pick a way to bring one
          online — this page updates the moment a runner connects.
        </p>
      </div>

      <div className="connect-options">
        <div className="connect-option">
          <div className="connect-option-head">
            <span className="connect-option-badge" aria-hidden>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="m4 17 6-6-6-6" />
                <path d="M12 19h8" />
              </svg>
            </span>
            <div className="connect-option-copy">
              <h3>Install on your own machine</h3>
              <p>Run one command on your Mac or Linux computer for persistent, always-ready work.</p>
            </div>
          </div>
          <div className="connect-command">
            <code>{INSTALL_CMD}</code>
            <button
              type="button"
              className={`connect-copy${copied ? " is-copied" : ""}`}
              onClick={copyCommand}
              aria-label={copied ? "Command copied" : "Copy install command"}
            >
              {copied ? (
                <>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m20 6-11 11-5-5" />
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                  </svg>
                  Copy
                </>
              )}
            </button>
          </div>
          <a className="connect-option-link" href="/install.sh">
            Prefer a file? Download the installer
          </a>
        </div>

        {ephemeralEnabled && (
          <div className="connect-option">
            <div className="connect-option-head">
              <span className="connect-option-badge" aria-hidden>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9.2 4 4 0 0 0 7 17" />
                  <path d="M12 12v6m0 0-2.5-2.5M12 18l2.5-2.5" />
                </svg>
              </span>
              <div className="connect-option-copy">
                <h3>No machine handy?</h3>
                <p>Spin up an ephemeral cloud server with your own provider token. It self-destructs after its TTL. Free plan included.</p>
              </div>
            </div>
            <button type="button" className="btn primary connect-option-cta" onClick={onEphemeral}>
              Launch ephemeral server
            </button>
          </div>
        )}
      </div>

      {persistentNodes.length > 0 && (
        <div className="connect-nodes">
          <div className="connect-nodes-head">Your nodes</div>
          <div className="connect-nodes-list">
            {persistentNodes.map((n) => (
              <button
                key={n.id}
                type="button"
                className="connect-node"
                onClick={() => onPickNode(n.id)}
                title={n.online ? "Start a new session on this node" : "This node is offline — selecting it will try to reconnect"}
              >
                <span className={`node-dot${n.online ? " online" : ""}`} aria-hidden />
                <span className="connect-node-name">{n.name || n.id}</span>
                <span className={`connect-node-status${n.online ? " is-online" : ""}`}>
                  {n.online ? "Online" : "Offline"}
                </span>
                <svg className="connect-node-caret" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="connect-waiting">
        <span className="onboarding-spinner" aria-hidden />
        <span className="connect-waiting-text">
          {persistentNodes.length > 0 ? "Or wait for another runner to connect…" : "Waiting for a runner to connect…"}
        </span>
        <button type="button" className="connect-refresh" onClick={onRefresh}>
          Refresh now
        </button>
      </div>
    </section>
  );
}
