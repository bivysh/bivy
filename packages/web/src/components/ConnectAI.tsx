// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// First run, right after choosing where agents run: sign in with the AI plans
// the user already pays for. The sign-in runs on the machine the agents use (the
// user's cloud machine, or their own computer), so the browser never handles
// the tokens.

import { useState } from "react";
import { modelAuthApiKeyProvider, type AppState } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { AI_ACCOUNTS, agentForProviders, rememberConnectAiDone, signInSync, type RunPlace } from "../onboarding.js";
import { ProviderConnectForm } from "./ProviderConnect.js";
import { Spinner } from "./Spinner.js";

export function ConnectAI({ state, place, startError, onRetry, onDone }: {
  state: AppState;
  place: RunPlace | null;
  /** Set when starting the cloud machine failed. */
  startError?: string;
  onRetry: () => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const nodeId = state.connection.currentNodeId;
  const online = Boolean(nodeId) && state.connection.status === "online";
  const cloud = place === "cloud" || Boolean(nodeId?.startsWith("eph-"));
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

  return (
    <section className="card readiness" aria-labelledby="connect-ai-title">
      <h2 id="connect-ai-title" className="card-title">Connect your AI</h2>
      <p className="card-sub">
        Sign in with the plans you already pay for. Connect both to switch agents any time.{" "}
        {cloud
          ? "Bivy keeps a copy so your cloud agents can run while you're away."
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

      <div className="get-started-actions">
        <button type="button" className="btn sm primary" disabled={!ready} onClick={finish}>Continue</button>
        {!ready && online && <button type="button" className="btn sm ghost" onClick={finish}>Set up later</button>}
      </div>
    </section>
  );
}
