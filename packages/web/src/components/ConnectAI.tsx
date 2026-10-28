// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// First run, right after sign-in: sign in with the AI plans the user already
// pays for. The sign-in runs on the machine the agents use (the user's cloud
// machine, or their own computer), so the browser never handles the tokens.
// The first connected plan picks its agent and hands over to the composer.

import { useEffect, useRef, useState } from "react";
import { modelAuthApiKeyProvider, type AppState } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { AI_ACCOUNTS, agentForProviders, rememberConnectAiDone, signInMachineOnline, signInSync, type RunPlace } from "../onboarding.js";
import { AddNodeSheet } from "./AddNodeSheet.js";
import { ProviderConnectForm } from "./ProviderConnect.js";
import { Spinner } from "./Spinner.js";

export function ConnectAI({ state, place, startError, onRetry, onDone, onUseOwn, deferrable = true }: {
  state: AppState;
  place: RunPlace | null;
  /** Offer "Set up later" (only the first time it's asked). */
  deferrable?: boolean;
  /** Set when starting the cloud machine failed. */
  startError?: string;
  onRetry: () => void;
  onDone: () => void;
  /** Bivy Cloud is the default; this switches the first run to the user's own computer. */
  onUseOwn: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [addingOwn, setAddingOwn] = useState(false);
  const nodeId = state.connection.currentNodeId;
  const online = signInMachineOnline(state.connection, controller.direct);
  // The selected machine decides, once there is one: picking your own computer
  // after choosing Bivy Cloud keeps sign-ins on that computer.
  const cloud = nodeId ? nodeId.startsWith("eph-") : place === "cloud";
  const machine = state.connection.nodes.find((node) => node.id === nodeId)?.name || "your computer";
  const providers = state.catalogs.providers;
  const isConnected = (provider: string) => providers.some((p) => (p.id === provider || p.id === modelAuthApiKeyProvider(provider)) && p.configured);
  // Once the machine has listed its providers, offer only the ones it can use.
  const rows = AI_ACCOUNTS.filter((account) => !providers.length || providers.some((p) => p.id === account.provider));
  const connected = rows.filter((account) => isConnected(account.provider)).map((account) => account.provider);
  const ready = connected.length > 0 || state.catalogs.activationReadiness?.credential.ok === true;

  const signIn = (provider: string) => {
    setOpen(provider);
    controller.startOauth(provider, undefined, signInSync(nodeId, place));
  };
  const finish = () => {
    const agent = agentForProviders(state.catalogs.runtimes, state.catalogs.selectedAgentId ?? "", connected);
    if (agent) controller.chooseAgent(agent);
    rememberConnectAiDone();
    onDone();
  };
  // Once a plan is connected (and the machine has listed its agents, so the
  // plan's agent can be chosen), there is nothing left to confirm.
  const finished = useRef(false);
  const runtimesListed = state.catalogs.runtimes.length > 0;
  useEffect(() => {
    if (!ready || !runtimesListed || finished.current) return;
    finished.current = true;
    finish();
  });

  return (
    <section className="card readiness" aria-labelledby="connect-ai-title">
      <h2 id="connect-ai-title" className="card-title">Connect your AI</h2>
      <p className="card-sub">
        Sign in with the plans you already pay for. Connect both to switch agents any time.{" "}
        {cloud
          ? "Your sign-in stays encrypted on this cloud computer. Another machine that's online can restore it, and this browser can restore an API key."
          : `Your sign-ins stay on ${machine}; Bivy's servers never get a copy.`}
      </p>

      {!online && (startError
        ? <div className="banner inline" data-tone="danger" role="alert">
            <span className="banner-text">Bivy Cloud didn't start: {startError}</span>
            <button type="button" className="btn sm banner-action" onClick={onRetry}>Try again</button>
          </div>
        : <p className="card-sub get-started-scan" role="status">
            <Spinner size="xs" />
            {cloud ? "Starting your cloud computer. The first start takes about a minute." : `Waiting for ${machine}…`}
          </p>)}

      <ul className="ai-accounts">
        {rows.map((account) => {
          const done = isConnected(account.provider);
          const expanded = open === account.provider && !done;
          return (
            <li key={account.provider} className="ai-account">
              <div className="ai-account-head">
                <span className="ai-account-text">
                  <span className="ai-account-name">{account.name}</span>
                  <span className="ai-account-plan">{account.plan}</span>
                </span>
                {done
                  ? <span className="ai-account-ok">✓ Connected</span>
                  : <span className="ai-account-actions">
                      <button type="button" className="btn sm ghost" disabled={!online} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : account.provider)}>
                        API key
                      </button>
                      <button type="button" className="btn sm primary" disabled={!online} onClick={() => signIn(account.provider)}>
                        Sign in<span className="sr-only"> with {account.name}</span>
                      </button>
                    </span>}
              </div>
              {expanded && (
                <ProviderConnectForm
                  state={state}
                  providerId={account.provider}
                  apiKeyProvider={modelAuthApiKeyProvider(account.provider) !== account.provider ? modelAuthApiKeyProvider(account.provider) : undefined}
                  keyOnly
                />
              )}
            </li>
          );
        })}
      </ul>

      {((online && deferrable) || cloud) && (
        <div className="get-started-actions">
          {online && deferrable && <button type="button" className="btn sm ghost" onClick={finish}>Set up later</button>}
          {cloud && <button type="button" className="btn sm ghost" onClick={() => { onUseOwn(); setAddingOwn(true); }}>Use my own computer instead</button>}
        </div>
      )}
      {addingOwn && <AddNodeSheet onClose={() => setAddingOwn(false)} />}
    </section>
  );
}
