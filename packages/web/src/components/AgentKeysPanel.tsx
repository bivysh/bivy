// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import type { AppState } from "@bivy/core";
import { controller } from "../store/useStore.js";
import type { AgentSecretInfo } from "../store/controller.js";
import { ConfirmDialog } from "./AppDialog.js";

function savedOn(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
}

/**
 * Settings → Keys for agents: the API keys and tokens agents asked for in the
 * chat (`bivy ask --secret`), stored on the connected machine. Agents use them
 * by name and never see the value; this lists them and removes them. The
 * machine's own tokens (GitHub, model providers) are not listed here.
 */
export function AgentKeysPanel({ state }: { state: AppState }) {
  const nodeOnline = state.connection.status === "online";
  const currentNodeId = state.connection.currentNodeId;
  const [keys, setKeys] = useState<AgentSecretInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<AgentSecretInfo | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (!nodeOnline) return;
    setKeys(null);
    setError(null);
    controller.listAgentSecrets().then(setKeys, (e) => setError(String((e as Error)?.message || e)));
  }, [nodeOnline, currentNodeId]);

  const remove = async (key: AgentSecretInfo) => {
    setConfirm(null);
    setRemoving(key.id);
    setError(null);
    try {
      setKeys(await controller.removeAgentSecret(key.id));
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setRemoving(null);
    }
  };

  if (!nodeOnline) {
    return (
      <div className="settings-form">
        <div className="vault-empty">
          <h4>No machine connected</h4>
          <p className="muted small">Keys are stored on your machines. Connect to one to see the keys agents use there.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-form">
      <p className="muted">Keys you gave agents in the chat, stored encrypted on this machine. Agents use them by name and never see the value.</p>
      {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
      {keys === null && !error && <p className="muted">Loading keys…</p>}
      {keys?.length === 0 && (
        <div className="vault-empty">
          <h4>No keys yet</h4>
          <p className="muted small">When an agent needs an API key or token, it asks in the chat and the key shows up here.</p>
        </div>
      )}
      {keys && keys.length > 0 && (
        <ul className="picker-list agent-keys" aria-label="Keys for agents">
          {keys.map((key) => (
            <li key={key.id} className="agent-key">
              <span className="agent-key-text">
                <strong className="agent-key-name">{key.id}</strong>
                {key.description && <small>{key.description}</small>}
                <small>{key.backend === "local" ? `Saved ${savedOn(key.updatedAt)}` : `Reference, updated ${savedOn(key.updatedAt)}`}</small>
              </span>
              <button type="button" className="btn sm danger-ghost" disabled={removing === key.id} onClick={() => setConfirm(key)} aria-label={`Remove ${key.id}`}>
                {removing === key.id ? "Removing…" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Remove ${confirm.id}?`}
          message="Agents on this machine lose access to it. The key still works at the service: revoke it there too if you no longer trust it."
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => void remove(confirm)}
        />
      )}
    </div>
  );
}
