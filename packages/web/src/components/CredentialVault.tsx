// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useMemo, useState } from "react";
import type { AppState, CredentialRecordSummary, EphemeralModelKeyInfo } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { OauthStep } from "./ProviderConnect.js";

type CatalogProvider = { id: string; name: string; oauth?: boolean; help?: string };
type Availability = "account" | "node" | "device";
type VaultItem = {
  provider: string;
  providerName: string;
  label: string;
  kind: "api_key" | "oauth" | "reference" | "environment";
  availability: Availability;
  record?: CredentialRecordSummary;
  device?: EphemeralModelKeyInfo;
  ambient?: boolean;
};

// Browser-safe fallback. The shared Bivy provider registry replaces/augments
// this list at build time; live nodes are always merged below so custom and
// newly-added providers remain visible.
const BASE_PROVIDERS: CatalogProvider[] = [
  { id: "anthropic", name: "Anthropic", oauth: true, help: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI", help: "https://platform.openai.com/api-keys" },
  { id: "openai-codex", name: "OpenAI — ChatGPT subscription", oauth: true },
  { id: "google", name: "Google Gemini", help: "https://aistudio.google.com/app/apikey" },
  { id: "xai", name: "xAI", oauth: true, help: "https://console.x.ai" },
  { id: "openrouter", name: "OpenRouter", help: "https://openrouter.ai/keys" },
  { id: "groq", name: "Groq", help: "https://console.groq.com/keys" },
  { id: "mistral", name: "Mistral" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "together", name: "Together AI" },
  { id: "fireworks", name: "Fireworks AI" },
  { id: "cohere", name: "Cohere" },
  { id: "perplexity", name: "Perplexity" },
];

const keyOf = (provider: string, label: string) => `${provider}\u0000${label || "default"}`;
const titleFor = (item: VaultItem) => item.label === "default" ? item.providerName : `${item.providerName} — ${item.label}`;
const methodLabel = (kind: VaultItem["kind"]) => kind === "oauth" ? "Subscription sign-in" : kind === "reference" ? "Password-manager reference" : kind === "environment" ? "Environment" : "API key";
const availabilityLabel = (value: Availability) => value === "account" ? "All my machines" : value === "node" ? "Only this machine" : "Only this device";

export function CredentialVault({ state }: { state: AppState }) {
  const [deviceKeys, setDeviceKeys] = useState<EphemeralModelKeyInfo[]>([]);
  const [view, setView] = useState<"list" | "add" | "detail">("list");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [method, setMethod] = useState<"api_key" | "oauth" | "reference">("api_key");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [availability, setAvailability] = useState<Availability>("account");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshDevice = () => controller.listEphemeralModelKeys().then(setDeviceKeys).catch(() => setDeviceKeys([]));
  const refresh = () => {
    controller.listProviders();
    controller.listCredentialRecords();
    controller.getCredentialPresets();
    void refreshDevice();
  };
  useEffect(() => { refresh(); }, [state.currentNodeId]);

  const catalog = useMemo(() => {
    const by = new Map(BASE_PROVIDERS.map((p) => [p.id, p]));
    for (const p of state.providers) by.set(p.id, { ...by.get(p.id), id: p.id, name: p.name || p.id, oauth: p.oauth });
    for (const r of state.credentialRecords) if (!by.has(r.provider)) by.set(r.provider, { id: r.provider, name: r.provider });
    for (const k of deviceKeys) if (!by.has(k.provider)) by.set(k.provider, { id: k.provider, name: k.provider });
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [state.providers, state.credentialRecords, deviceKeys]);
  const providerName = (id: string) => catalog.find((p) => p.id === id)?.name || id;

  const items = useMemo(() => {
    const out = new Map<string, VaultItem>();
    for (const record of state.credentialRecords) out.set(keyOf(record.provider, record.label), {
      provider: record.provider,
      providerName: providerName(record.provider),
      label: record.label,
      kind: record.kind,
      availability: record.sync === "account" ? "account" : "node",
      record,
    });
    for (const device of deviceKeys) {
      const id = keyOf(device.provider, device.label);
      const current = out.get(id);
      out.set(id, {
        ...(current ?? { provider: device.provider, providerName: providerName(device.provider), label: device.label, kind: "api_key" as const }),
        availability: device.scope === "device" ? "device" : current?.availability ?? "account",
        device,
      });
    }
    for (const p of state.providers) if (p.configured && ![...out.values()].some((item) => item.provider === p.id)) {
      out.set(keyOf(p.id, "default"), {
        provider: p.id, providerName: p.name || p.id, label: "default",
        kind: p.kind === "oauth" ? "oauth" : "environment", availability: "node", ambient: true,
      });
    }
    return [...out.values()].sort((a, b) => a.providerName.localeCompare(b.providerName) || a.label.localeCompare(b.label));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.credentialRecords, state.providers, deviceKeys, catalog]);

  const selected = selectedKey ? items.find((item) => keyOf(item.provider, item.label) === selectedKey) : undefined;
  const providerCounts = useMemo(() => new Map(items.map((item) => [item.provider, items.filter((x) => x.provider === item.provider).length])), [items]);

  const resetAdd = (id = "") => {
    setProvider(id); setMethod("api_key"); setLabel(""); setSecret(""); setAvailability("account"); setError(null); setMessage(null);
  };

  const save = async () => {
    const id = provider.trim().toLowerCase();
    const account = label.trim().toLowerCase() || "default";
    if (!id) return;
    if (method !== "oauth" && !secret.trim()) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      if (method === "oauth") {
        if (state.status !== "online") throw new Error("An online machine is needed to complete subscription sign-in.");
        controller.startOauth(id);
        return;
      }
      if (method === "api_key") {
        if (availability === "account" || availability === "device") {
          await controller.setEphemeralModelKey(id, secret.trim(), availability === "device" ? "device" : "account", account);
        }
        if (availability !== "device") {
          if (state.status !== "online") {
            if (availability === "node") throw new Error("Connect to the machine where this key should be stored.");
          } else {
            await controller.setCredential(id, account, { key: secret.trim() });
            if (availability === "node") await controller.setCredentialSync(id, account, "node");
          }
        }
      } else {
        if (state.status !== "online") throw new Error("Connect a machine to add a password-manager reference.");
        await controller.setCredential(id, account, { ref: secret.trim() });
        await controller.setCredentialSync(id, account, availability === "account" ? "account" : "node");
      }
      setMessage("Credential saved.");
      setSecret("");
      refresh();
      setSelectedKey(keyOf(id, account));
      setView("detail");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: VaultItem) => {
    if (!window.confirm(`Delete ${titleFor(item)}? Agents using it will lose access.`)) return;
    setBusy(true); setError(null);
    try {
      if (item.device) await controller.removeEphemeralModelKey(item.provider, item.label);
      if (item.record) await controller.removeCredential(item.provider, item.label);
      setView("list"); setSelectedKey(null); refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (view === "add") {
    const chosen = catalog.find((p) => p.id === provider);
    if (!chosen) {
      const matches = catalog.filter((p) => `${p.name} ${p.id}`.toLowerCase().includes(query.toLowerCase()));
      return <div className="settings-form credential-vault">
        <button className="link-btn" onClick={() => setView("list")}>‹ Credentials</button>
        <h3>Add credential</h3>
        <p className="muted">Choose the provider you want Bivy to use.</p>
        <input autoFocus className="picker-search" placeholder="Search providers…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="picker-list">
          {matches.map((p) => <button key={p.id} className="picker-item" onClick={() => { resetAdd(p.id); setProvider(p.id); }}>
            <span><strong>{p.name}</strong><small>{p.id}</small></span><span aria-hidden>›</span>
          </button>)}
          {matches.length === 0 && <button className="picker-item" onClick={() => { resetAdd(query.trim().toLowerCase()); setProvider(query.trim().toLowerCase()); }}>
            <span><strong>Custom provider</strong><small>Use “{query}” as the provider ID</small></span><span aria-hidden>›</span>
          </button>}
        </div>
      </div>;
    }
    return <div className="settings-form credential-vault">
      <button className="link-btn" onClick={() => setProvider("")}>‹ Providers</button>
      <h3>{chosen.name}</h3>
      {state.oauth?.provider === chosen.id ? <OauthStep /> : <>
        <label className="field-label">Sign-in method</label>
        <div className="vault-methods">
          {chosen.oauth && <button className={`btn ${method === "oauth" ? "primary" : ""}`} onClick={() => setMethod("oauth")}>Subscription sign-in</button>}
          <button className={`btn ${method === "api_key" ? "primary" : ""}`} onClick={() => setMethod("api_key")}>API key</button>
          <button className={`btn ${method === "reference" ? "primary" : ""}`} onClick={() => setMethod("reference")}>Password manager</button>
        </div>
        {method !== "oauth" && <>
          <label className="field-label">Name <span className="muted">(optional)</span></label>
          <input className="picker-search" placeholder="e.g. Work — leave empty for the default" value={label} onChange={(e) => setLabel(e.target.value)} />
          <label className="field-label">{method === "reference" ? "Reference" : "API key"}</label>
          <input className="picker-search" type={method === "reference" ? "text" : "password"} placeholder={method === "reference" ? "op://Vault/Item/field, env://NAME, or cmd://…" : "Paste API key"} value={secret} onChange={(e) => setSecret(e.target.value)} />
          {chosen.help && method === "api_key" && <a className="link-btn" href={chosen.help} target="_blank" rel="noreferrer">Where to create a key ↗</a>}
          <label className="field-label">Available on</label>
          <select className="picker-search" value={availability} onChange={(e) => setAvailability(e.target.value as Availability)}>
            <option value="account">All my machines — end-to-end encrypted</option>
            <option value="node">Only this machine</option>
            {method === "api_key" && <option value="device">Only this device</option>}
          </select>
        </>}
        <button className="btn primary block" disabled={busy || (method !== "oauth" && !secret.trim())} onClick={save}>{busy ? "Saving…" : method === "oauth" ? `Sign in with ${chosen.name}` : "Save credential"}</button>
      </>}
      {error && <div className="banner error inline" role="alert">{error}</div>}
    </div>;
  }

  if (view === "detail" && selected) {
    const count = providerCounts.get(selected.provider) ?? 1;
    const isDefault = (state.credentialPresets?.presets?.default?.[selected.provider] ?? "default") === selected.label;
    const projectPreset = state.draftRepo ? `project:${state.draftRepo}` : undefined;
    const projectLabel = projectPreset ? state.credentialPresets?.presets?.[projectPreset]?.[selected.provider] : undefined;
    const usedByProject = projectLabel === selected.label;
    return <div className="settings-form credential-vault">
      <button className="link-btn" onClick={() => setView("list")}>‹ Credentials</button>
      <div className="vault-title-row"><div><h3>{titleFor(selected)}</h3><p className="muted">{methodLabel(selected.kind)}</p></div><span className={`chip ${selected.record?.lastVerifiedOk ? "ok" : ""}`}>{selected.record?.lastVerifiedOk ? "Verified" : selected.ambient ? "Provided by environment" : "Saved"}</span></div>
      <div className="vault-detail-grid">
        <span className="muted">Available on</span><strong>{availabilityLabel(selected.availability)}</strong>
        <span className="muted">Used by default</span><strong>{isDefault ? "Yes" : "No"}</strong>
        {state.draftRepo && <><span className="muted">Current project</span><strong>{usedByProject ? state.draftRepo : projectLabel ? `Uses ${projectLabel}` : "Uses provider default"}</strong></>}
        {selected.record?.origin === "agent-native" && <><span className="muted">Added by</span><strong>Agent sign-in</strong></>}
        {selected.record?.ref && <><span className="muted">Reference</span><code>{selected.record.ref}</code></>}
      </div>
      {selected.record && <div className="row-actions">
        {selected.record.testable && <button className="btn" disabled={busy} onClick={async () => { setBusy(true); setError(null); const result = await controller.testCredential(selected.provider, selected.label).catch(() => ({ ok: false, at: Date.now(), reason: "network_error" })); setMessage(result.ok ? "Connection verified." : `Verification failed: ${result.reason || "unknown error"}.`); refresh(); setBusy(false); }}>Test connection</button>}
        {count > 1 && !isDefault && <button className="btn" onClick={() => { controller.setPresetMapping("default", selected.provider, selected.label); setMessage("Now used by default."); setTimeout(() => controller.getCredentialPresets(), 150); }}>Use by default</button>}
        {count > 1 && projectPreset && !usedByProject && <button className="btn" onClick={() => { controller.setPresetMapping(projectPreset, selected.provider, selected.label); setMessage(`Assigned to ${state.draftRepo}.`); setTimeout(() => controller.getCredentialPresets(), 150); }}>Use for {state.draftRepo}</button>}
        {projectPreset && usedByProject && <button className="btn" onClick={() => { controller.setPresetMapping(projectPreset, selected.provider, ""); setMessage(`${state.draftRepo} now uses the provider default.`); setTimeout(() => controller.getCredentialPresets(), 150); }}>Clear project assignment</button>}
      </div>}
      {!selected.ambient && <>
        <details className="vault-advanced"><summary>Replace or change availability</summary>
          <p className="muted small">Re-enter the secret to replace it or move it. Bivy never displays saved secrets.</p>
          <button className="btn" onClick={() => { resetAdd(selected.provider); setLabel(selected.label === "default" ? "" : selected.label); setMethod(selected.kind === "reference" ? "reference" : "api_key"); setAvailability(selected.availability); setView("add"); }}>Edit credential</button>
        </details>
        <button className="btn danger-ghost" disabled={busy} onClick={() => void remove(selected)}>Delete credential</button>
      </>}
      {message && <p className="banner inline">{message}</p>}{error && <div className="banner error inline">{error}</div>}
      {state.nodes.length > 0 && <details className="vault-advanced"><summary>Machine availability</summary><div className="picker-list">{state.nodes.map((n) => <div className="picker-item" key={n.id}><span><strong>{n.name || n.id}</strong><small>{n.online ? selected.availability === "device" ? "Device-only credential is not available" : "Online" : "Will sync when online"}</small></span><span className={`chip ${n.online ? "ok" : ""}`}>{n.online ? "Online" : "Offline"}</span></div>)}</div></details>}
    </div>;
  }

  const filtered = items.filter((item) => `${item.providerName} ${item.provider} ${item.label}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="settings-form credential-vault">
    <div className="vault-title-row"><div><h3>Credential vault</h3><p className="muted settings-intro">Model keys and subscription sign-ins, encrypted and ready where you allow them.</p></div><button className="btn primary" onClick={() => { resetAdd(); setQuery(""); setView("add"); }}>+ Add</button></div>
    {items.length === 0 ? <div className="vault-empty"><h4>No credentials yet</h4><p className="muted">Add a model provider to start using agents.</p><button className="btn primary" onClick={() => setView("add")}>Add credential</button></div> : <>
      <input className="picker-search" placeholder="Search credentials…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="picker-list vault-items">{filtered.map((item) => <button className="picker-item" key={keyOf(item.provider, item.label)} onClick={() => { setSelectedKey(keyOf(item.provider, item.label)); setMessage(null); setError(null); setView("detail"); }}>
        <span><strong>{titleFor(item)}</strong><small>{methodLabel(item.kind)} · {availabilityLabel(item.availability)}</small></span><span className="vault-row-status">{item.record?.lastVerifiedOk && <span className="chip ok">Verified</span>}<span aria-hidden>›</span></span>
      </button>)}</div>
    </>}
  </div>;
}
