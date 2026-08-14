// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useMemo, useState } from "react";
import type { AppState, CredentialRecordSummary, EphemeralModelKeyInfo } from "@bivy/core";
import { BIVY_PROVIDER_CATALOG, mergeCredentialItems, migrateBrowserModelKeys, migrateNodeCredentialSummaries } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { OauthStep } from "./ProviderConnect.js";
import { ConfirmDialog } from "./AppDialog.js";

type CatalogProvider = { id: string; name: string; oauth?: boolean; apiKey?: boolean; reference?: boolean; help?: string };
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

const BASE_PROVIDERS: CatalogProvider[] = BIVY_PROVIDER_CATALOG.map((provider) => ({
  id: provider.id,
  name: provider.name,
  oauth: provider.authMethods.some((method) => method.kind === "oauth"),
  apiKey: provider.authMethods.some((method) => method.kind === "api_key"),
  reference: provider.authMethods.some((method) => method.kind === "reference"),
  help: provider.authMethods.find((method) => method.kind === "api_key")?.helpUrl,
}));

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
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customApi, setCustomApi] = useState("openai-completions");
  const [customModels, setCustomModels] = useState("");
  const [availability, setAvailability] = useState<Availability>("account");
  const [assignmentProject, setAssignmentProject] = useState(state.draftRepo ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<VaultItem | null>(null);

  const refreshDevice = () => controller.listEphemeralModelKeys().then(setDeviceKeys).catch(() => setDeviceKeys([]));
  const refresh = () => {
    controller.listProviders();
    controller.listCredentialRecords();
    controller.getCredentialPresets();
    void refreshDevice();
  };
  useEffect(() => {
    controller.listProviders();
    controller.listCredentialRecords();
    controller.getCredentialPresets();
    controller.listRepos();
    void controller.listEphemeralModelKeys().then(setDeviceKeys).catch(() => setDeviceKeys([]));
  }, [state.currentNodeId]);

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
    const logicalItems = mergeCredentialItems(
      migrateBrowserModelKeys(deviceKeys),
      migrateNodeCredentialSummaries(state.credentialRecords, state.currentNodeId || "current-node"),
    );
    for (const item of logicalItems) {
      const record = state.credentialRecords.find((candidate) => candidate.provider === item.provider && candidate.label === item.label);
      const device = deviceKeys.find((candidate) => candidate.provider === item.provider && candidate.label === item.label);
      out.set(keyOf(item.provider, item.label), {
        provider: item.provider,
        providerName: providerName(item.provider),
        label: item.label,
        kind: item.kind,
        availability: item.availability.account ? "account" : device?.scope === "device" ? "device" : "node",
        ...(record ? { record } : {}),
        ...(device ? { device } : {}),
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
  }, [state.credentialRecords, state.providers, state.currentNodeId, deviceKeys, catalog]);

  const selected = selectedKey ? items.find((item) => keyOf(item.provider, item.label) === selectedKey) : undefined;
  const providerCounts = useMemo(() => new Map(items.map((item) => [item.provider, items.filter((x) => x.provider === item.provider).length])), [items]);

  const resetAdd = (id = "") => {
    setProvider(id); setMethod("api_key"); setLabel(""); setSecret(""); setCustomBaseUrl(""); setCustomApi("openai-completions"); setCustomModels(""); setAvailability("account"); setError(null); setMessage(null);
  };

  const save = async () => {
    const id = provider.trim().toLowerCase();
    const account = label.trim().toLowerCase() || "default";
    if (!id) return;
    const catalogKnown = BASE_PROVIDERS.some((entry) => entry.id === id)
      || (state.providers.some((entry) => entry.id === id) && !state.localModels.some((entry) => entry.id === id))
      || items.some((entry) => entry.provider === id && !state.localModels.some((model) => model.id === id));
    if (catalogKnown && method !== "oauth" && !secret.trim()) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      if (!catalogKnown) {
        if (state.status !== "online") throw new Error("Connect a machine to configure a custom model endpoint.");
        if (!customBaseUrl.trim()) throw new Error("A custom provider needs a base URL.");
        const savedId = await controller.saveLocalModel({
          providerId: id,
          name: id,
          baseUrl: customBaseUrl.trim(),
          api: customApi,
          ...(secret.trim() ? { apiKey: secret.trim() } : {}),
          models: customModels.split(/[,\n]/).map((model) => model.trim()).filter(Boolean).map((modelId) => ({ id: modelId, name: modelId })),
        });
        controller.listLocalModels();
        refresh();
        setMessage("Custom provider saved.");
        setSelectedKey(keyOf(savedId, "default"));
        setView("detail");
        return;
      }
      if (method === "oauth") {
        if (state.status !== "online") throw new Error("An online machine is needed to complete subscription sign-in.");
        if (deviceKeys.some((record) => record.provider === id && record.label === account)) await controller.removeEphemeralModelKey(id, account);
        controller.startOauth(id, account);
        return;
      }
      if (method === "api_key") {
        const nodeRecord = state.credentialRecords.find((record) => record.provider === id && record.label === account);
        const deviceRecord = deviceKeys.find((record) => record.provider === id && record.label === account);
        if (availability === "device" && nodeRecord && state.status !== "online") {
          throw new Error("Connect a machine to remove its existing copy before making this credential device-only.");
        }
        if (availability === "account" || availability === "device") {
          await controller.setEphemeralModelKey(id, secret.trim(), availability === "device" ? "device" : "account", account);
        } else if (deviceRecord) {
          await controller.removeEphemeralModelKey(id, account);
        }
        if (availability === "device") {
          if (nodeRecord) await controller.removeCredential(id, account);
        } else if (state.status !== "online") {
          if (availability === "node") throw new Error("Connect to the machine where this key should be stored.");
        } else {
          await controller.setCredential(id, account, { key: secret.trim(), sync: availability === "node" ? "node" : "account" });
        }
      } else {
        if (state.status !== "online") throw new Error("Connect a machine to add a password-manager reference.");
        if (deviceKeys.some((record) => record.provider === id && record.label === account)) await controller.removeEphemeralModelKey(id, account);
        await controller.setCredential(id, account, { ref: secret.trim(), sync: availability === "account" ? "account" : "node" });
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

  const assign = async (preset: string, providerId: string, account: string, success: string) => {
    setBusy(true); setError(null);
    try {
      await controller.setPresetMapping(preset, providerId, account);
      setMessage(success);
      controller.getCredentialPresets();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: VaultItem) => {
    setBusy(true); setError(null);
    try {
      if (state.localModels.some((model) => model.id === item.provider)) controller.removeLocalModel(item.provider);
      if (item.device) await controller.removeEphemeralModelKey(item.provider, item.label);
      if (item.record) await controller.removeCredential(item.provider, item.label);
      setConfirmDelete(null);
      setView("list"); setSelectedKey(null); refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (view === "add") {
    const chosen = catalog.find((p) => p.id === provider) ?? (provider ? { id: provider, name: provider } : undefined);
    if (!chosen) {
      const matches = catalog.filter((p) => `${p.name} ${p.id}`.toLowerCase().includes(query.toLowerCase()));
      return <div className="settings-form credential-vault">
        <button className="link-btn" onClick={() => setView("list")}>‹ Credentials</button>
        <h3>Add credential</h3>
        <p className="muted">Choose the provider you want Bivy to use.</p>
        <input autoFocus className="picker-search" placeholder="Search providers…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="picker-list">
          {matches.map((p) => <button key={p.id} className="picker-item" onClick={() => { resetAdd(p.id); setProvider(p.id); if (p.apiKey === false && p.oauth) setMethod("oauth"); }}>
            <span><strong>{p.name}</strong><small>{p.id}</small></span><span aria-hidden>›</span>
          </button>)}
          {matches.length === 0 && <button className="picker-item" onClick={() => { resetAdd(query.trim().toLowerCase()); setProvider(query.trim().toLowerCase()); }}>
            <span><strong>Custom provider</strong><small>Use “{query}” as the provider ID</small></span><span aria-hidden>›</span>
          </button>}
        </div>
      </div>;
    }
    const customProvider = state.localModels.some((entry) => entry.id === chosen.id)
      || (!BASE_PROVIDERS.some((entry) => entry.id === chosen.id) && !state.providers.some((entry) => entry.id === chosen.id) && !items.some((entry) => entry.provider === chosen.id));
    const editingItem = selected?.provider === chosen.id;
    const discloseOptions = editingItem || items.some((item) => item.provider === chosen.id);
    const identityOptions = <>
      {discloseOptions && <>
        <label className="field-label" htmlFor="credential-name">Name <span className="muted">(optional)</span></label>
        <input id="credential-name" className="picker-search" placeholder="e.g. Work — leave empty for the default" value={label} onChange={(e) => setLabel(e.target.value)} />
      </>}
      {method !== "oauth" && <>
        <label className="field-label" htmlFor="credential-availability">Available on</label>
        <select id="credential-availability" className="picker-search" value={availability} onChange={(e) => setAvailability(e.target.value as Availability)}>
          <option value="account">All my machines — end-to-end encrypted</option>
          <option value="node">Only this machine</option>
          {method === "api_key" && <option value="device">Only this device</option>}
        </select>
      </>}
    </>;
    return <div className="settings-form credential-vault">
      <button className="link-btn" onClick={() => setProvider("")}>‹ Providers</button>
      <h3>{customProvider ? "Custom provider" : chosen.name}</h3>
      {state.oauth?.provider === chosen.id ? <OauthStep /> : <>
        {customProvider && <>
          <label className="field-label" htmlFor="custom-provider-id">Provider ID</label>
          <input id="custom-provider-id" className="picker-search" value={provider} onChange={(e) => setProvider(e.target.value.toLowerCase())} />
          <label className="field-label" htmlFor="custom-provider-endpoint">Endpoint</label>
          <input id="custom-provider-endpoint" className="picker-search" placeholder="https://api.example.com/v1" value={customBaseUrl} onChange={(e) => setCustomBaseUrl(e.target.value)} />
          <label className="field-label" htmlFor="custom-provider-api">API compatibility</label>
          <select id="custom-provider-api" className="picker-search" value={customApi} onChange={(e) => setCustomApi(e.target.value)}>
            <option value="openai-completions">OpenAI-compatible</option>
            <option value="openai-responses">OpenAI Responses</option>
            <option value="azure-openai-responses">Azure OpenAI</option>
            <option value="anthropic-messages">Anthropic Messages</option>
          </select>
          <label className="field-label" htmlFor="custom-provider-models">Models <span className="muted">(one per line, optional)</span></label>
          <textarea id="custom-provider-models" className="picker-search" rows={3} placeholder="model-id" value={customModels} onChange={(e) => setCustomModels(e.target.value)} />
        </>}
        {!customProvider && <div className="vault-methods" role="group" aria-label="Sign-in method">
          {chosen.oauth && <button aria-pressed={method === "oauth"} className={`btn ${method === "oauth" ? "primary" : ""}`} onClick={() => setMethod("oauth")}>Subscription sign-in</button>}
          {chosen.apiKey !== false && <button aria-pressed={method === "api_key"} className={`btn ${method === "api_key" ? "primary" : ""}`} onClick={() => setMethod("api_key")}>API key</button>}
          {chosen.reference !== false && <button aria-pressed={method === "reference"} className={`btn ${method === "reference" ? "primary" : ""}`} onClick={() => { setMethod("reference"); if (availability === "device") setAvailability("node"); }}>Password manager</button>}
        </div>}
        {!customProvider && (discloseOptions ? identityOptions : method !== "oauth" ? <details className="vault-advanced"><summary>Advanced options</summary>{identityOptions}</details> : null)}
        {method !== "oauth" && <>
          <label className="field-label" htmlFor="credential-secret">{method === "reference" ? "Reference" : "API key"}</label>
          <input id="credential-secret" className="picker-search" type={method === "reference" ? "text" : "password"} placeholder={method === "reference" ? "op://Vault/Item/field, env://NAME, or cmd://…" : "Paste API key"} value={secret} onChange={(e) => setSecret(e.target.value)} />
          {chosen.help && method === "api_key" && <a className="link-btn" href={chosen.help} target="_blank" rel="noreferrer">Where to create a key ↗</a>}
        </>}
        <button className="btn primary block" disabled={busy || (!customProvider && method !== "oauth" && !secret.trim()) || (customProvider && !customBaseUrl.trim())} onClick={save}>{busy ? "Saving…" : method === "oauth" ? `Sign in with ${chosen.name}` : customProvider ? "Save custom provider" : "Save credential"}</button>
      </>}
      {error && <div className="banner error inline" role="alert">{error}</div>}
    </div>;
  }

  if (view === "detail" && selected) {
    const count = providerCounts.get(selected.provider) ?? 1;
    const isDefault = (state.credentialPresets?.presets?.default?.[selected.provider] ?? "default") === selected.label;
    const projectId = assignmentProject.trim();
    const projectPreset = projectId ? `project:${projectId}` : undefined;
    const projectLabel = projectPreset ? state.credentialPresets?.presets?.[projectPreset]?.[selected.provider] : undefined;
    const usedByProject = projectLabel === selected.label;
    const assignedProjects = Object.entries(state.credentialPresets?.presets ?? {})
      .filter(([name, mapping]) => name.startsWith("project:") && mapping?.[selected.provider] === selected.label)
      .map(([name]) => name.slice("project:".length));
    const projectOptions = [...new Set([
      ...state.repos.map((repo) => repo.slug),
      ...Object.keys(state.credentialPresets?.presets ?? {}).filter((name) => name.startsWith("project:")).map((name) => name.slice("project:".length)),
    ])].sort();
    return <div className="settings-form credential-vault">
      {confirmDelete && <ConfirmDialog
        title="Delete credential?"
        message={`Delete ${titleFor(confirmDelete)}? Agents and projects using it will lose access.`}
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => void remove(confirmDelete)}
      />}
      <button className="link-btn" onClick={() => setView("list")}>‹ Credentials</button>
      <div className="vault-title-row"><div><h3>{titleFor(selected)}</h3><p className="muted">{methodLabel(selected.kind)}</p></div><span className={`chip ${selected.record?.lastVerifiedOk ? "ok" : ""}`}>{selected.record?.lastVerifiedOk ? "Verified" : selected.ambient ? "Provided by environment" : "Saved"}</span></div>
      <div className="vault-detail-grid">
        <span className="muted">Available on</span><strong>{availabilityLabel(selected.availability)}</strong>
        <span className="muted">Used by default</span><strong>{isDefault ? "Yes" : "No"}</strong>
        <span className="muted">Used by projects</span><strong>{assignedProjects.length ? assignedProjects.join(", ") : "None explicitly — projects use the default"}</strong>
        {assignmentProject && <><span className="muted">Selected project</span><strong>{usedByProject ? "Uses this credential" : projectLabel ? `Uses ${projectLabel}` : "Uses provider default"}</strong></>}
        {selected.record && <><span className="muted">Unattended runs</span><strong>{selected.record.unattended ? "Allowed (separate hosted custody)" : "Not allowed"}</strong></>}
        {selected.record?.origin === "agent-native" && <><span className="muted">Added by</span><strong>Agent sign-in</strong></>}
        {selected.record?.ref && <><span className="muted">Reference</span><code>{selected.record.ref}</code></>}
      </div>
      {selected.record && <div className="row-actions">
        {selected.record.testable && <button className="btn" disabled={busy} onClick={async () => { setBusy(true); setError(null); const result = await controller.testCredential(selected.provider, selected.label).catch(() => ({ ok: false, at: Date.now(), reason: "network_error" })); setMessage(result.ok ? "Connection verified." : `Verification failed: ${result.reason || "unknown error"}.`); refresh(); setBusy(false); }}>Test connection</button>}
        {count > 1 && !isDefault && <button className="btn" disabled={busy} onClick={() => void assign("default", selected.provider, selected.label, "Now used by default.")}>Use by default</button>}
        {count > 1 && projectPreset && !usedByProject && <button className="btn" disabled={busy} onClick={() => void assign(projectPreset, selected.provider, selected.label, `Assigned to ${projectId}.`)}>Use for {projectId}</button>}
        {projectPreset && usedByProject && <button className="btn" disabled={busy} onClick={() => void assign(projectPreset, selected.provider, "", `${projectId} now uses the provider default.`)}>Clear project assignment</button>}
        {selected.record.sync === "account" && selected.record.kind !== "reference" && <button className="btn" disabled={busy} onClick={async () => { setBusy(true); setError(null); try { await controller.setCredentialUnattended(selected.provider, selected.label, !selected.record!.unattended); setMessage(selected.record!.unattended ? "Unattended access revoked." : "Unattended access granted with separate hosted custody."); refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }}>{selected.record.unattended ? "Revoke unattended access" : "Allow unattended runs"}</button>}
      </div>}
      {count > 1 && <div>
        <label className="field-label" htmlFor="credential-project">Assign for project or repository</label>
        <input id="credential-project" className="picker-search" list="credential-project-options" placeholder="owner/repository or project ID" value={assignmentProject} onChange={(e) => setAssignmentProject(e.target.value)} />
        <datalist id="credential-project-options">{projectOptions.map((project) => <option key={project} value={project} />)}</datalist>
      </div>}
      {!selected.ambient && <>
        <details className="vault-advanced"><summary>Replace or change availability</summary>
          <p className="muted small">Re-enter the secret to replace it or move it. Bivy never displays saved secrets.</p>
          <button className="btn" onClick={() => { const custom = state.localModels.find((model) => model.id === selected.provider); resetAdd(selected.provider); setLabel(selected.label === "default" ? "" : selected.label); setMethod(selected.kind === "reference" ? "reference" : "api_key"); setAvailability(selected.availability); if (custom) { setCustomBaseUrl(custom.baseUrl); setCustomApi(custom.api); setCustomModels(custom.models.map((model) => model.id).join("\n")); } setView("add"); }}>Edit credential</button>
        </details>
        <button className="btn danger-ghost" disabled={busy} onClick={() => setConfirmDelete(selected)}>Delete credential</button>
      </>}
      {message && <p className="banner inline">{message}</p>}{error && <div className="banner error inline">{error}</div>}
      {state.nodes.length > 0 && <details className="vault-advanced"><summary>Machine availability</summary><div className="picker-list">{state.nodes.map((n) => {
        const available = selected.availability === "account" || (selected.availability === "node" && n.id === state.currentNodeId);
        const status = !available ? "Not available" : n.online ? "Available" : selected.availability === "account" ? "Will sync when online" : "Offline";
        return <div className="picker-item" key={n.id}><span><strong>{n.name || n.id}</strong><small>{status}</small></span><span className={`chip ${available && n.online ? "ok" : ""}`}>{status}</span></div>;
      })}</div></details>}
    </div>;
  }

  const filtered = items.filter((item) => `${item.providerName} ${item.provider} ${item.label}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="settings-form credential-vault">
    <div className="vault-title-row"><div><h3>Credential vault</h3><p className="muted settings-intro">Model keys and subscription sign-ins, encrypted and ready where you allow them.</p></div><button className="btn primary" onClick={() => { setSelectedKey(null); resetAdd(); setQuery(""); setView("add"); }}>+ Add</button></div>
    {items.length === 0 ? <div className="vault-empty"><h4>No credentials yet</h4><p className="muted">Add a model provider to start using agents.</p><button className="btn primary" onClick={() => { setSelectedKey(null); resetAdd(); setView("add"); }}>Add credential</button></div> : <>
      <input className="picker-search" placeholder="Search credentials…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="picker-list vault-items">{filtered.map((item) => <button className="picker-item" key={keyOf(item.provider, item.label)} onClick={() => { setSelectedKey(keyOf(item.provider, item.label)); setMessage(null); setError(null); setView("detail"); }}>
        <span><strong>{titleFor(item)}</strong><small>{methodLabel(item.kind)} · {availabilityLabel(item.availability)}</small></span><span className="vault-row-status">{item.record?.lastVerifiedOk && <span className="chip ok">Verified</span>}<span aria-hidden>›</span></span>
      </button>)}</div>
    </>}
  </div>;
}
