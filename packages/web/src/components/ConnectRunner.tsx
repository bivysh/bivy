// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import type { AccountNode } from "@bivy/core";
import { writeClipboard } from "../clipboard.js";
import { Spinner } from "./Spinner.js";
import { StatusDot } from "./StatusDot.js";
import { installCommand } from "../installCommand.js";
import { controller } from "../store/useStore.js";

/**
 * The "no Machine connected" onboarding screen shown on a fresh session before a
 * node is selected. Presents the two ways to get a Machine online — install on
 * your own computer, or (when enabled) spin up an ephemeral cloud server — plus,
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
  const [copied, setCopied] = useState<"auto" | "plain" | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hosted: the one-line installer. Self-hosted: point `bivy setup` at this
  // deployment, since only bivy.sh serves install.sh (see installCommand.ts).
  const install = installCommand(location.origin, controller.local.relay, controller.local.s);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  // Ephemeral machines (id `eph-…`) live in their own launcher, not the
  // persistent node list — mirror the node switcher so a booted ephemeral runner
  // isn't offered here as if it were a regular enrolled node.
  const persistentNodes = nodes.filter((n) => !n.id.startsWith("eph-"));

  const copyCommand = async (command: string, kind: "auto" | "plain") => {
    const ok = await writeClipboard(command);
    if (!ok) return;
    setCopied(kind);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1800);
  };

  return (
    <section className="connect-runner" aria-labelledby="connect-runner-title">
      <div className="connect-hero compact">
        <h2 className="connect-title" id="connect-runner-title">{persistentNodes.length > 0 ? "Choose a Machine" : "Connect a Machine"}</h2>
        <p className="connect-sub">
          {persistentNodes.length > 0
            ? "Pick an online Machine to start, or add another workstation."
            : ephemeralEnabled
              ? "Use a workstation with your real repo, services, and warm caches, or launch an isolated Machine. Any hosted credential custody is disclosed before enablement."
              : "Use the workstation where your repo, services, and warm caches already live."}
        </p>
      </div>

      {persistentNodes.length > 0 && (
        <div className="connect-nodes">
          <div className="connect-nodes-head">Your machines</div>
          <div className="connect-nodes-list">
            {persistentNodes.map((n) => (
              <button
                key={n.id}
                type="button"
                className="connect-node"
                onClick={() => onPickNode(n.id)}
                title={n.online ? "Start on this Machine" : "This Machine is offline — selecting it will try to reconnect"}
              >
                <StatusDot status={n.online ? "online" : "idle"} />
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
              <h3>{persistentNodes.length > 0 ? "Add another workstation" : "Connect your workstation"}</h3>
              <p>
                Paste this on the Mac or Linux computer where your repo lives.
                {install.authenticated && " It can use this account automatically."}
                {!install.hosted && " Needs Node.js 22.19 or newer."}
              </p>
            </div>
          </div>
          <div className="connect-command">
            <code>{install.command}</code>
            <button
              type="button"
              className={`connect-copy icon-only${copied === "auto" ? " is-copied" : ""}`}
              onClick={() => copyCommand(install.command, "auto")}
              aria-label={copied === "auto" ? "Command copied" : install.authenticated ? "Copy auto sign-in install command" : "Copy install command"}
              title={copied === "auto" ? "Copied" : install.authenticated ? "Copy auto sign-in" : "Copy"}
            >
              {copied === "auto" ? (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m20 6-11 11-5-5" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                </svg>
              )}
            </button>
          </div>
          <div className="connect-option-links">
            {install.authenticated && (
              <button type="button" className="btn link" onClick={() => copyCommand(install.plainCommand, "plain")}>
                {copied === "plain" ? "Plain command copied" : "Use plain install"}
              </button>
            )}
            {install.hosted && <a className="connect-option-link" href="/install.sh">Download script</a>}
          </div>
          {install.authenticated && (
            <p className="connect-token-note">Auto sign-in includes an account token. Use only on a Machine you trust.</p>
          )}
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
                <h3>Launch an isolated Machine</h3>
                <p>Fastest if you don't want to install locally. Start with the recommended cloud, review its estimated cost and teardown policy, then launch explicitly with your first task. Bivy adds no fee.</p>
              </div>
            </div>
            <button type="button" className="btn primary connect-option-cta" onClick={onEphemeral}>
              Launch isolated Machine
            </button>
          </div>
        )}
      </div>


      <div className="connect-waiting">
        <Spinner size="sm" />
        <span className="connect-waiting-text">
          {persistentNodes.length > 0 ? "Or wait for another Machine to connect…" : "Waiting for a Machine to connect…"}
        </span>
        <button type="button" className="connect-refresh" onClick={onRefresh}>
          Refresh now
        </button>
      </div>
    </section>
  );
}
