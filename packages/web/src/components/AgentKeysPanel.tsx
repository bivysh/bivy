// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { Fragment, useEffect, useState } from "react";
import { KEY_NAME, parseKeyLines, type AppState, type KeyLine } from "@bivy/core";
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
 * by name and never see the value; this lists, adds and removes them. Pasting
 * `.env` / `export NAME=value` lines into the name field adds them all at once.
 * The machine's own tokens (GitHub, model providers) are not listed here.
 */
export function AgentKeysPanel({ state }: { state: AppState }) {
  const nodeOnline = state.connection.status === "online";
  const currentNodeId = state.connection.currentNodeId;
  const [keys, setKeys] = useState<AgentSecretInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<AgentSecretInfo | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [pasted, setPasted] = useState<{ keys: KeyLine[]; skipped: number[] } | null>(null);
  const [saving, setSaving] = useState(false);

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

  const save = async (entries: KeyLine[]) => {
    setSaving(true);
    setError(null);
    try {
      setKeys(await controller.setAgentSecrets(entries));
      setName("");
      setValue("");
      setPasted(null);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setSaving(false);
    }
  };
  const validName = KEY_NAME.test(name.trim());
  const saved = new Set(keys?.map((key) => key.id));

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
      <p className="muted">Keys for agents on this machine, stored encrypted. Agents use them by name and never see the value.</p>
      {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
      {keys === null && !error && <p className="muted">Loading keys…</p>}
      {keys?.length === 0 && (
        <div className="vault-empty">
          <h4>No keys yet</h4>
          <p className="muted small">When an agent needs an API key or token, it asks in the chat and the key shows up here. You can also add one below.</p>
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
      <form className="field-row" aria-label="Add a key" onSubmit={(e) => {
        e.preventDefault();
        if (validName && value) void save([{ name: name.trim(), value }]);
      }}>
        <input className="field" value={name} placeholder="NAME" aria-label="Key name" autoComplete="off" spellCheck={false}
          aria-invalid={Boolean(name) && !validName || undefined} aria-describedby="agent-keys-paste-hint"
          onChange={(e) => setName(e.target.value)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (!text.includes("=")) return;
            e.preventDefault();
            setPasted(parseKeyLines(text));
          }} />
        <input className="field" type="password" value={value} placeholder="Value" aria-label="Key value" autoComplete="new-password"
          onChange={(e) => setValue(e.target.value)} />
        <button type="submit" className="btn primary" disabled={saving || !validName || !value}>{saved.has(name.trim()) ? "Replace" : "Add"}</button>
      </form>
      {Boolean(name) && !validName
        ? <p className="settings-error">A name is a letter followed by letters, digits or underscores, like STRIPE_API_KEY.</p>
        : <p className="muted small" id="agent-keys-paste-hint">Or paste lines like <code>export NAME=value</code> from a <code>.env</code> file into the name field to add several.</p>}
      {pasted && (
        <div className="banner inline" data-tone="accent">
          {pasted.keys.length === 0
            ? <span className="banner-text" role="status">No keys in the paste. Each line needs a name and a value, like <code>NAME=value</code>.</span>
            : (
              <span className="banner-text" role="status"><span>
                {pasted.keys.length === 1 ? "1 key" : `${pasted.keys.length} keys`}: {pasted.keys.map((key, i) => (
                  <Fragment key={key.name}>{i > 0 && ", "}<code>{key.name}</code>{saved.has(key.name) && " (replaces the saved one)"}</Fragment>
                ))}.
                {pasted.skipped.length > 0 && ` Skipped line${pasted.skipped.length === 1 ? "" : "s"} ${pasted.skipped.join(", ")}.`}
              </span></span>
            )}
          <span className="banner-actions">
            {pasted.keys.length > 0 && (
              <button type="button" className="btn sm primary" disabled={saving} onClick={() => void save(pasted.keys)}>
                {saving ? "Saving…" : pasted.keys.length === 1 ? "Save 1 key" : `Save ${pasted.keys.length} keys`}
              </button>
            )}
            <button type="button" className="btn sm ghost" disabled={saving} onClick={() => setPasted(null)}>Cancel</button>
          </span>
        </div>
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
