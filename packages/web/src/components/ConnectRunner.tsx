// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { AccountNode } from "@bivy/core";
import { MachineInstallInstructions } from "./MachineInstallInstructions.js";
import { Spinner } from "./Spinner.js";
import { StatusDot } from "./StatusDot.js";

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
  // Ephemeral machines (id `eph-…`) live in their own launcher, not the
  // persistent node list — mirror the node switcher so a booted ephemeral runner
  // isn't offered here as if it were a regular enrolled node.
  const persistentNodes = nodes.filter((n) => !n.id.startsWith("eph-"));

  return (
    <section className="connect-runner" aria-labelledby="connect-runner-title">
      <div className="connect-hero compact">
        <h2 className="connect-title" id="connect-runner-title">{persistentNodes.length > 0 ? "Choose a Machine" : "Connect a Machine"}</h2>
        <p className="connect-sub">
          {persistentNodes.length > 0
            ? "Pick an online machine to start, or add another machine."
            : ephemeralEnabled
              ? "Use a machine with your real repository, services, and warm caches, or launch an isolated machine. Any hosted credential custody is disclosed before enablement."
              : "Use the machine where your repository, services, and warm caches already live."}
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
        <div className="connect-option machine-install-card">
          <MachineInstallInstructions />
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
        <button type="button" className="btn sm ghost" onClick={onRefresh}>
          Refresh now
        </button>
      </div>
    </section>
  );
}
