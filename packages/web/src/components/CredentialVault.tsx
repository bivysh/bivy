// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppState, CredentialRecordSummary, EphemeralModelKeyInfo, LocalModelEndpointResult } from "@bivy/core";
import { BIVY_PROVIDER_CATALOG, mergeCredentialItems, migrateBrowserModelKeys, migrateNodeCredentialSummaries } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { OauthStep } from "./ProviderConnect.js";
import { ConfirmDialog } from "./AppDialog.js";
import { Badge } from "./Badge.js";

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
  const status = state.connection.status;
  const currentNodeId = state.connection.currentNodeId;
  const nodes = state.connection.nodes;
  const providers = state.catalogs.providers;
  const repos = state.catalogs.repos;
  const credentialRecords = state.settings.credentialRecords;
  const credentialPresets = state.settings.credentialPresets;
  const localModels = state.settings.localModels;
  const oauth = state.presentation.oauth;
  const [deviceKeys, setDeviceKeys] = useState<EphemeralModelKeyInfo[]>([]);
  const [view, setView] = useState<"list" | "add" | "detail">("list");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [method, setMethod] = useState<"api_key" | "oauth" | "reference">("api_key");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [customName, setCustomName] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customApi, setCustomApi] = useState("openai-completions");
  const [customModels, setCustomModels] = useState("");
  const [customMode, setCustomMode] = useState(false);
  const [verification, setVerification] = useState<LocalModelEndpointResult | null>(null);
  const [availability, setAvailability] = useState<Availability>("account");
  const [assignmentProject, setAssignmentProject] = useState(state.draft.repo ?? "");
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
    controller.listLocalModels();
    controller.listRepos();
    void controller.listEphemeralModelKeys().then(setDeviceKeys).catch(() => setDeviceKeys([]));
  }, [currentNodeId]);

  // OAuth completion clears the shared OAuth state. Return to the same saved
  // provider detail shown when a user opens it from the list, rather than
  // leaving them on a now-empty sign-in form with no success confirmation.
  const oauthAttempt = useRef<{ provider: string; label: string } | null>(null);
  const pendingOauthDetail = useRef<string | null>(null);
  useEffect(() => {
    if (oauth) {
      oauthAttempt.current = { provider: oauth.provider || provider, label: label.trim().toLowerCase() || "default" };
      return;
    }
    if (!oauthAttempt.current) return;
    const completed = oauthAttempt.current;
    oauthAttempt.current = null;
    pendingOauthDetail.current = keyOf(completed.provider, completed.label);
    setMessage("Sign-in complete.");
    refresh();
  // `label` is deliberately captured while the attempt is active.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauth]);

  const catalog = useMemo(() => {
    const by = new Map(BASE_PROVIDERS.map((p) => [p.id, p]));
    for (const p of providers) by.set(p.id, { ...by.get(p.id), id: p.id, name: p.name || p.id, oauth: p.oauth });
    for (const r of credentialRecords) if (!by.has(r.provider)) by.set(r.provider, { id: r.provider, name: r.provider });
    for (const k of deviceKeys) if (!by.has(k.provider)) by.set(k.provider, { id: k.provider, name: k.provider });
    for (const endpoint of localModels) by.set(endpoint.id, { id: endpoint.id, name: endpoint.name || endpoint.id });
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [providers, credentialRecords, deviceKeys, localModels]);
  const providerName = (id: string) => catalog.find((p) => p.id === id)?.name || id;

  const items = useMemo(() => {
    const out = new Map<string, VaultItem>();
    const logicalItems = mergeCredentialItems(
      migrateBrowserModelKeys(deviceKeys),
      migrateNodeCredentialSummaries(credentialRecords, currentNodeId || "current-node"),
    );
    for (const item of logicalItems) {
      const record = credentialRecords.find((candidate) => candidate.provider === item.provider && candidate.label === item.label);
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
    for (const p of providers) if (p.configured && ![...out.values()].some((item) => item.provider === p.id)) {
      out.set(keyOf(p.id, "default"), {
        provider: p.id, providerName: p.name || p.id, label: "default",
        kind: p.kind === "oauth" ? "oauth" : "environment", availability: "node", ambient: true,
      });
    }
    for (const endpoint of localModels) if (!out.has(keyOf(endpoint.id, "default"))) {
      out.set(keyOf(endpoint.id, "default"), {
        provider: endpoint.id, providerName: endpoint.name || endpoint.id, label: "default",
        kind: "api_key", availability: endpoint.scope === "machine" ? "node" : "account",
      });
    }
    return [...out.values()].sort((a, b) => a.providerName.localeCompare(b.providerName) || a.label.localeCompare(b.label));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentialRecords, providers, currentNodeId, deviceKeys, catalog, localModels]);

  const selected = selectedKey ? items.find((item) => keyOf(item.provider, item.label) === selectedKey) : undefined;
  useEffect(() => {
    if (!pendingOauthDetail.current || !items.some((item) => keyOf(item.provider, item.label) === pendingOauthDetail.current)) return;
    setSelectedKey(pendingOauthDetail.current);
    pendingOauthDetail.current = null;
    setView("detail");
  }, [items]);
  const providerCounts = useMemo(() => new Map(items.map((item) => [item.provider, items.filter((x) => x.provider === item.provider).length])), [items]);

  const resetAdd = (id = "") => {
    setProvider(id); setMethod("api_key"); setLabel(""); setSecret(""); setCustomName(""); setCustomBaseUrl(""); setCustomApi("openai-completions"); setCustomModels(""); setCustomMode(false); setVerification(null); setAvailability("account"); setError(null); setMessage(null);
  };

  const save = async () => {
    const id = provider.trim().toLowerCase();
    const account = label.trim().toLowerCase() || "default";
    if (!id) return;
    const catalogKnown = !customMode && (BASE_PROVIDERS.some((entry) => entry.id === id)
      || (providers.some((entry) => entry.id === id) && !localModels.some((entry) => entry.id === id))
      || items.some((entry) => entry.provider === id && !localModels.some((model) => model.id === id)));
    if (catalogKnown && method !== "oauth" && !secret.trim()) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      if (!catalogKnown) {
        if (status !== "online") throw new Error("Connect a machine to configure a custom model endpoint.");
        if (!customBaseUrl.trim()) throw new Error("A custom provider needs a base URL.");
        const savedId = await controller.saveLocalModel({
          providerId: id,
          name: customName.trim() || id,
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
        if (status !== "online") throw new Error("An online machine is needed to complete subscription sign-in.");
        if (deviceKeys.some((record) => record.provider === id && record.label === account)) await controller.removeEphemeralModelKey(id, account);
        controller.startOauth(id, account);
        return;
      }
      if (method === "api_key") {
        const nodeRecord = credentialRecords.find((record) => record.provider === id && record.label === account);
        const deviceRecord = deviceKeys.find((record) => record.provider === id && record.label === account);
        if (availability === "device" && nodeRecord && status !== "online") {
          throw new Error("Connect a machine to remove its existing copy before making this credential device-only.");
        }
        if (availability === "account" || availability === "device") {
          await controller.setEphemeralModelKey(id, secret.trim(), availability === "device" ? "device" : "account", account);
        } else if (deviceRecord) {
          await controller.removeEphemeralModelKey(id, account);
        }
        if (availability === "device") {
          if (nodeRecord) await controller.removeCredential(id, account);
        } else if (status !== "online") {
          if (availability === "node") throw new Error("Connect to the machine where this key should be stored.");
        } else {
          await controller.setCredential(id, account, { key: secret.trim(), sync: availability === "node" ? "node" : "account" });
        }
      } else {
        if (status !== "online") throw new Error("Connect a machine to add a password-manager reference.");
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
      if (localModels.some((model) => model.id === item.provider)) controller.removeLocalModel(item.provider);
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
        <button className="btn link" onClick={() => setView("list")}>‹ Credentials</button>
        <h3>Add model access</h3>
        <p className="muted">Connect a hosted provider or point Bivy at a model server you control.</p>
        <button className="custom-provider-card" onClick={() => { const id = query.trim().toLowerCase() || "local"; resetAdd(id); setProvider(id); setCustomMode(true); }}>
          <span className="custom-provider-card-icon" aria-hidden>＋</span>
          <span><strong>Local server or custom endpoint</strong><small>Ollama, LM Studio, vLLM, Azure, or another compatible API</small></span>
          <span aria-hidden>›</span>
        </button>
        <div className="vault-picker-label">Hosted providers</div>
        <input autoFocus className="picker-search" placeholder="Search providers…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="picker-list">
          {matches.map((p) => <button key={p.id} className="picker-item" onClick={() => { resetAdd(p.id); setProvider(p.id); if (p.apiKey === false && p.oauth) setMethod("oauth"); }}>
            <span><strong>{p.name}</strong><small>{p.id}</small></span><span aria-hidden>›</span>
          </button>)}
          {matches.length === 0 && <div className="picker-empty">No hosted providers match. Add it as a custom endpoint above.</div>}
        </div>
      </div>;
    }
    const customProvider = customMode || localModels.some((entry) => entry.id === chosen.id)
      || (!BASE_PROVIDERS.some((entry) => entry.id === chosen.id) && !providers.some((entry) => entry.id === chosen.id) && !items.some((entry) => entry.provider === chosen.id));
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
      <button className="btn link" onClick={() => setProvider("")}>‹ Providers</button>
      <h3>{customProvider ? "Custom provider" : chosen.name}</h3>
      {oauth?.provider === chosen.id ? <OauthStep /> : <>
        {customProvider && <>
          <p className="muted">Use a local model server or any OpenAI-, Anthropic-, or Azure-compatible endpoint.</p>
          <label className="field-label" htmlFor="custom-provider-name">Display name</label>
          <input id="custom-provider-name" className="picker-search" placeholder="My local models" value={customName} onChange={(e) => setCustomName(e.target.value)} />
          <label className="field-label" htmlFor="custom-provider-id">Provider ID</label>
          <input id="custom-provider-id" className="picker-search" value={provider} disabled={editingItem} onChange={(e) => setProvider(e.target.value.toLowerCase())} />
          <label className="field-label" htmlFor="custom-provider-endpoint">Endpoint</label>
          <input id="custom-provider-endpoint" className="picker-search" placeholder="https://api.example.com/v1" value={customBaseUrl} onChange={(e) => setCustomBaseUrl(e.target.value)} />
          <label className="field-label" htmlFor="custom-provider-api">API compatibility</label>
          <select id="custom-provider-api" className="picker-search" value={customApi} onChange={(e) => setCustomApi(e.target.value)}>
            <option value="openai-completions">OpenAI-compatible</option>
            <option value="openai-responses">OpenAI Responses</option>
            <option value="azure-openai-responses">Azure OpenAI</option>
            <option value="anthropic-messages">Anthropic Messages</option>
          </select>
          <label className="field-label" htmlFor="custom-provider-key">API key <span className="muted">(optional)</span></label>
          <input id="custom-provider-key" className="picker-search" type="password" placeholder="Leave blank for local servers without authentication" value={secret} onChange={(e) => setSecret(e.target.value)} />
          <div className="row-actions">
            <button className="btn" disabled={busy || !customBaseUrl.trim()} onClick={async () => {
              setBusy(true); setError(null); setVerification(null);
              try {
                const result = await controller.verifyLocalModel(customBaseUrl.trim(), secret.trim() || undefined);
                setVerification(result);
                if (result.status === "ready") setCustomModels(result.models.map((model) => model.id).join("\n"));
              } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
              finally { setBusy(false); }
            }}>{busy ? "Checking…" : "Test endpoint & find models"}</button>
          </div>
          {verification && <div className={`banner inline ${verification.status === "ready" ? "success" : "error"}`}>
            {verification.status === "ready" ? `Connected on ${verification.machineName}. Found ${verification.models.length} model${verification.models.length === 1 ? "" : "s"}.` : verification.detail || "This endpoint could not be reached."}
          </div>}
          <label className="field-label" htmlFor="custom-provider-models">Models <span className="muted">(one per line)</span></label>
          <textarea id="custom-provider-models" className="picker-search" rows={3} placeholder="model-id" value={customModels} onChange={(e) => setCustomModels(e.target.value)} />
        </>}
        {!customProvider && <div className="vault-methods" role="group" aria-label="Sign-in method">
          {chosen.oauth && <button aria-pressed={method === "oauth"} className={`btn ${method === "oauth" ? "primary" : ""}`} onClick={() => setMethod("oauth")}>Subscription sign-in</button>}
          {chosen.apiKey !== false && <button aria-pressed={method === "api_key"} className={`btn ${method === "api_key" ? "primary" : ""}`} onClick={() => setMethod("api_key")}>API key</button>}
          {chosen.reference !== false && <button aria-pressed={method === "reference"} className={`btn ${method === "reference" ? "primary" : ""}`} onClick={() => { setMethod("reference"); if (availability === "device") setAvailability("node"); }}>Password manager</button>}
        </div>}
        {!customProvider && (discloseOptions ? identityOptions : method !== "oauth" ? <details className="vault-advanced"><summary>Advanced options</summary>{identityOptions}</details> : null)}
        {method !== "oauth" && !customProvider && <>
          <label className="field-label" htmlFor="credential-secret">{method === "reference" ? "Reference" : "API key"}</label>
          <input id="credential-secret" className="picker-search" type={method === "reference" ? "text" : "password"} placeholder={method === "reference" ? "op://Vault/Item/field, env://NAME, or cmd://…" : "Paste API key"} value={secret} onChange={(e) => setSecret(e.target.value)} />
          {chosen.help && method === "api_key" && <a className="btn link" href={chosen.help} target="_blank" rel="noreferrer">Where to create a key ↗</a>}
        </>}
        <button className="btn primary block" disabled={busy || (!customProvider && method !== "oauth" && !secret.trim()) || (customProvider && !customBaseUrl.trim())} onClick={save}>{busy ? "Saving…" : method === "oauth" ? `Sign in with ${chosen.name}` : customProvider ? "Save custom provider" : "Save credential"}</button>
      </>}
      {error && <div className="banner error inline" role="alert">{error}</div>}
    </div>;
  }

  if (view === "detail" && selected) {
    const count = providerCounts.get(selected.provider) ?? 1;
    const isDefault = (credentialPresets?.presets?.default?.[selected.provider] ?? "default") === selected.label;
    const projectId = assignmentProject.trim();
    const projectPreset = projectId ? `project:${projectId}` : undefined;
    const projectLabel = projectPreset ? credentialPresets?.presets?.[projectPreset]?.[selected.provider] : undefined;
    const usedByProject = projectLabel === selected.label;
    const assignedProjects = Object.entries(credentialPresets?.presets ?? {})
      .filter(([name, mapping]) => name.startsWith("project:") && mapping?.[selected.provider] === selected.label)
      .map(([name]) => name.slice("project:".length));
    const projectOptions = [...new Set([
      ...repos.map((repo) => repo.slug),
      ...Object.keys(credentialPresets?.presets ?? {}).filter((name) => name.startsWith("project:")).map((name) => name.slice("project:".length)),
    ])].sort();
    return <div className="settings-form credential-vault">
      {confirmDelete && <ConfirmDialog
        title={localModels.some((model) => model.id === confirmDelete.provider) ? "Remove endpoint?" : "Delete credential?"}
        message={localModels.some((model) => model.id === confirmDelete.provider) ? `Remove ${titleFor(confirmDelete)} and its models?` : `Delete ${titleFor(confirmDelete)}? Agents and projects using it will lose access.`}
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => void remove(confirmDelete)}
      />}
      <button className="btn link" onClick={() => setView("list")}>‹ Credentials</button>
      <div className="vault-title-row"><div><h3>{titleFor(selected)}</h3><p className="muted">{localModels.some((model) => model.id === selected.provider) ? "Local or custom endpoint" : methodLabel(selected.kind)}</p></div><Badge tone={selected.record?.lastVerifiedOk ? "ok" : undefined}>{selected.record?.lastVerifiedOk ? "Verified" : selected.ambient ? "Provided by environment" : "Saved"}</Badge></div>
      <div className="vault-detail-grid">
        <span className="muted">Available on</span><strong>{availabilityLabel(selected.availability)}</strong>
        <span className="muted">Used by default</span><strong>{isDefault ? "Yes" : "No"}</strong>
        <span className="muted">Used by projects</span><strong>{assignedProjects.length ? assignedProjects.join(", ") : "None explicitly — projects use the default"}</strong>
        {assignmentProject && <><span className="muted">Selected project</span><strong>{usedByProject ? "Uses this credential" : projectLabel ? `Uses ${projectLabel}` : "Uses provider default"}</strong></>}
        {selected.record && <><span className="muted">Unattended runs</span><strong>{selected.record.unattended ? "Allowed — encrypted cloud copy enabled" : "Not allowed"}</strong></>}
        {selected.record?.origin === "agent-native" && <><span className="muted">Added by</span><strong>Agent sign-in</strong></>}
        {selected.record?.ref && <><span className="muted">Reference</span><code>{selected.record.ref}</code></>}
      </div>
      {selected.record && <div className="row-actions">
        {selected.record.testable && <button className="btn" disabled={busy} onClick={async () => { setBusy(true); setError(null); const result = await controller.testCredential(selected.provider, selected.label).catch(() => ({ ok: false, at: Date.now(), reason: "network_error" })); setMessage(result.ok ? "Connection verified." : `Verification failed: ${result.reason || "unknown error"}.`); refresh(); setBusy(false); }}>Test connection</button>}
        {count > 1 && !isDefault && <button className="btn" disabled={busy} onClick={() => void assign("default", selected.provider, selected.label, "Now used by default.")}>Use by default</button>}
        {count > 1 && projectPreset && !usedByProject && <button className="btn" disabled={busy} onClick={() => void assign(projectPreset, selected.provider, selected.label, `Assigned to ${projectId}.`)}>Use for {projectId}</button>}
        {projectPreset && usedByProject && <button className="btn" disabled={busy} onClick={() => void assign(projectPreset, selected.provider, "", `${projectId} now uses the provider default.`)}>Clear project assignment</button>}
        {selected.record.sync === "account" && selected.record.kind !== "reference" && <button className="btn" disabled={busy} onClick={async () => { setBusy(true); setError(null); try { await controller.setCredentialUnattended(selected.provider, selected.label, !selected.record!.unattended); setMessage(selected.record!.unattended ? "Unattended access revoked and its encrypted cloud copy removed." : "Unattended access enabled with a separate encrypted cloud copy."); refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }}>{selected.record.unattended ? "Disable unattended runs" : "Allow unattended runs"}</button>}
      </div>}
      {selected.record?.sync === "account" && selected.record.kind !== "reference" && <p className="muted vault-custody-note">To run while all your devices are offline, Bivy stores a separate encrypted copy of this credential in its control plane. This is opt-in, used only for unattended runs, and removed when you disable access.</p>}
      {count > 1 && <div>
        <label className="field-label" htmlFor="credential-project">Assign for project or repository</label>
        <input id="credential-project" className="picker-search" list="credential-project-options" placeholder="owner/repository or project ID" value={assignmentProject} onChange={(e) => setAssignmentProject(e.target.value)} />
        <datalist id="credential-project-options">{projectOptions.map((project) => <option key={project} value={project} />)}</datalist>
      </div>}
      {!selected.ambient && <>
        <details className="vault-advanced"><summary>Replace or change availability</summary>
          <p className="muted small">Re-enter the secret to replace it or move it. Bivy never displays saved secrets.</p>
          <button className="btn" onClick={() => { const custom = localModels.find((model) => model.id === selected.provider); resetAdd(selected.provider); setLabel(selected.label === "default" ? "" : selected.label); setMethod(selected.kind === "reference" ? "reference" : "api_key"); setAvailability(selected.availability); if (custom) { setCustomMode(true); setCustomName(custom.name || custom.id); setCustomBaseUrl(custom.baseUrl); setCustomApi(custom.api); setCustomModels(custom.models.map((model) => model.id).join("\n")); } setView("add"); }}>Edit credential</button>
        </details>
        <button className="btn danger-ghost" disabled={busy} onClick={() => setConfirmDelete(selected)}>{localModels.some((model) => model.id === selected.provider) ? "Remove endpoint" : "Delete credential"}</button>
      </>}
      {message && <p className="banner inline">{message}</p>}{error && <div className="banner error inline">{error}</div>}
      {nodes.length > 0 && <details className="vault-advanced"><summary>Machine availability</summary><div className="picker-list">{nodes.map((n) => {
        const available = selected.availability === "account" || (selected.availability === "node" && n.id === currentNodeId);
        const status = !available ? "Not available" : n.online ? "Available" : selected.availability === "account" ? "Will sync when online" : "Offline";
        return <div className="picker-item" key={n.id}><span><strong>{n.name || n.id}</strong><small>{status}</small></span><Badge tone={available && n.online ? "ok" : undefined}>{status}</Badge></div>;
      })}</div></details>}
    </div>;
  }

  const filtered = items.filter((item) => `${item.providerName} ${item.provider} ${item.label}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="settings-form credential-vault">
    <div className="vault-title-row"><div><h3>Your model access</h3><p className="muted settings-intro">Hosted providers, subscription sign-ins, API keys, and your own model endpoints.</p></div><button className="btn primary" onClick={() => { setSelectedKey(null); resetAdd(); setQuery(""); setView("add"); }}>+ Add</button></div>
    {items.length === 0 ? <div className="vault-empty"><h4>No providers yet</h4><p className="muted">Add a sign-in, API key, local model, or custom endpoint.</p><button className="btn primary" onClick={() => { setSelectedKey(null); resetAdd(); setView("add"); }}>Add provider</button></div> : <>
      <input className="picker-search" placeholder="Search credentials…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="picker-list vault-items">{filtered.map((item) => <button className="picker-item" key={keyOf(item.provider, item.label)} onClick={() => { setSelectedKey(keyOf(item.provider, item.label)); setMessage(null); setError(null); setView("detail"); }}>
        <span><strong>{titleFor(item)}</strong><small>{localModels.some((model) => model.id === item.provider) ? "Local or custom endpoint" : methodLabel(item.kind)} · {availabilityLabel(item.availability)}</small></span><span className="vault-row-status">{item.record?.lastVerifiedOk && <Badge tone="ok">Verified</Badge>}<span aria-hidden>›</span></span>
      </button>)}</div>
    </>}
  </div>;
}
