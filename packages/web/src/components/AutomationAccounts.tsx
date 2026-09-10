// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";
import type { AppState } from "@bivy/core";
import { controller } from "../store/controller.js";

/** Explicit run-local assignments; never mutate the user's credential presets. */
export function AutomationAccounts({ state, value, onChange }: {
  state: AppState;
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
}) {
  useEffect(() => { controller.listCredentialRecords(); }, [state.connection.currentNodeId]);
  const records = state.settings.credentialRecords;
  const providers = [...new Set([...records.map((r) => r.provider), ...Object.keys(value)])].sort();
  return <div className="autom-field-block">
    <h3 className="autom-section-heading">Provider accounts &amp; keys</h3>
    <p className="settings-hint">Pin accounts for this automation, or keep machine/project defaults. Your other sessions are unaffected.</p>
    {!providers.length && <p className="settings-hint" role="status">No accounts loaded. Connect to a machine and add provider accounts in Settings to select one here.</p>}
    <div className="wizard-advanced">
      {providers.map((provider) => {
        const accounts = records.filter((r) => r.provider === provider);
        const name = state.catalogs.providers.find((p) => p.id === provider)?.name || provider;
        const selected = value[provider] || "";
        const id = `autom-account-${provider}`;
        return <div className="settings-field" key={provider}>
          <label className="field-label" htmlFor={id}>{name} account</label>
          <select id={id} className="picker-search" value={selected} onChange={(e) => {
            const next = { ...value };
            if (e.target.value) next[provider] = e.target.value;
            else delete next[provider];
            onChange(next);
          }}>
            <option value="">Machine/project default</option>
            {accounts.map((r) => <option key={r.label} value={r.label}>{r.label === "default" ? "Default account" : r.label}</option>)}
            {selected && !accounts.some((r) => r.label === selected) && <option value={selected}>{selected} (unavailable here)</option>}
          </select>
        </div>;
      })}
    </div>
    <details>
      <summary className="settings-hint">Account availability &amp; agent support</summary>
      <p className="settings-hint">Accounts shown are from the connected machine. Selected accounts are checked on the assigned runner when each run starts; missing accounts fail the run. Agents that manage their own login cannot use overrides. Subscription overrides require a Bivy-managed model agent, except Anthropic subscriptions which also work with CLI agents.</p>
    </details>
  </div>;
}
