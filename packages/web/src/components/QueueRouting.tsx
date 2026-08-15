// SPDX-License-Identifier: AGPL-3.0-only
// Account-level queue routing (issue #532 / ephemeral configs). Picks the
// default runner for queued work — the shared queue, a persistent node, or an
// ephemeral config (a reusable, named runner template shown "as a node"). A
// persistent-node primary may carry an ephemeral-config fallback for when the
// node is offline; an ephemeral-config primary needs none (it's provisioned on
// demand). Also manages the account's ephemeral configs (create/edit/remove).
//
// This lived inside the old Settings "Webhooks" panel; it moved here when the
// Automations hub absorbed everything automation/policy, and is rendered by the
// Work Queue tab (AutomationsView) — the natural home for "where does queued
// work run". Gated by EPHEMERAL_MACHINES_ENABLED, same as before.
import { useEffect, useState } from "react";
import { ephemeralCatalogEntry, type AccountNode, type EphemeralNodeConfig, type HostedProvisioningStatus, type ProviderKeyInfo, type QueueRouting } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { PickerItem } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { Badge } from "./Badge.js";

/** Editable form state for one ephemeral config. */
type EphemeralConfigDraft = {
  editing?: string;
  name: string;
  provider: string;
  region: string;
  size: string;
  ttlMinutes: number | null;
  readyCapacity: boolean;
  teardownOnAgentFinish: boolean;
};

const QUEUE_TTL_OPTIONS = [
  { v: 30, label: "30 min" },
  { v: 60, label: "1 hour" },
  { v: 180, label: "3 hours" },
];

/** Local switch — mirrors the Settings Toggle so this module stays self-contained. */
function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`settings-toggle${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-toggle-knob" aria-hidden />
    </button>
  );
}

export function QueueRoutingSection({
  hosted,
  onConfigureCredentials,
}: {
  hosted?: HostedProvisioningStatus | null;
  onConfigureCredentials?: () => void;
}) {
  const [nodes, setNodes] = useState<AccountNode[]>([]);
  const [configs, setConfigs] = useState<EphemeralNodeConfig[]>([]);
  const [routing, setRouting] = useState<QueueRouting | null>(null);
  const [keys, setKeys] = useState<ProviderKeyInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<EphemeralConfigDraft | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<EphemeralNodeConfig | null>(null);

  const refreshConfigs = () => controller.listEphemeralConfigs().then(setConfigs).catch(() => {});
  useEffect(() => {
    controller.listNodes().then(setNodes).catch(() => {});
    controller.listEphemeralKeys().then(setKeys).catch(() => {});
    controller.getQueueRouting().then(setRouting).catch(() => setRouting(null));
    refreshConfigs();
  }, []);

  const persistentNodes = nodes.filter((n) => !n.id.startsWith("eph-"));
  const primaryValue = routing?.primary.kind === "node" ? `node:${routing.primary.node}`
    : routing?.primary.kind === "config" ? `config:${routing.primary.configId}` : "shared";
  const fallbackValue = routing?.fallback?.kind === "config" ? `config:${routing.fallback.configId}` : "";
  const primaryIsNode = routing?.primary.kind === "node";
  const providerName = (id: string) => keys.find((k) => k.id === id)?.name || id;
  const providerReady = (id: string) => Boolean(keys.find((k) => k.id === id)?.configured);

  const saveRouting = async (primaryStr: string, fallbackStr: string) => {
    setErr(null);
    setBusy(true);
    try {
      const primary: QueueRouting["primary"] = primaryStr.startsWith("node:")
        ? { kind: "node", node: primaryStr.slice("node:".length) }
        : primaryStr.startsWith("config:")
          ? { kind: "config", configId: primaryStr.slice("config:".length) }
          : { kind: "shared" };
      const next: QueueRouting = primary.kind === "node" && fallbackStr.startsWith("config:")
        ? { primary, fallback: { kind: "config", configId: fallbackStr.slice("config:".length) } }
        : { primary };
      setRouting(await controller.setQueueRouting(next));
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const saveConfig = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) { setErr("Profile name is required"); return; }
    if (!draft.provider) { setErr("Choose a provider"); return; }
    setErr(null);
    setBusy(true);
    try {
      const input = {
        name, provider: draft.provider,
        region: draft.region.trim() || null,
        size: draft.size.trim() || null,
        ttlMinutes: draft.ttlMinutes ?? null,
        readyCapacity: readyCapacityEligible && draft.readyCapacity ? 1 : 0,
        teardownOnAgentFinish: draft.teardownOnAgentFinish,
      };
      if (draft.editing) await controller.updateEphemeralConfig(draft.editing, input);
      else await controller.createEphemeralConfig(input);
      setDraft(null);
      refreshConfigs();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };
  const readyCapacityEligible = draft ? ephemeralCatalogEntry(draft.provider)?.computeClass === "byo-cloud" : false;

  const removeConfig = async (cfg: EphemeralNodeConfig) => {
    setConfirmRemove(null);
    setBusy(true);
    try {
      await controller.removeEphemeralConfig(cfg.id);
      refreshConfigs();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const selectedConfigId = routing?.primary.kind === "config" ? routing.primary.configId : "";
  const fallbackConfigId = routing?.fallback?.configId ?? "";
  const selectedConfig = selectedConfigId ? configs.find((c) => c.id === selectedConfigId) : undefined;
  const fallbackConfig = fallbackConfigId ? configs.find((c) => c.id === fallbackConfigId) : undefined;
  const hostedCanRun = (config?: EphemeralNodeConfig) => Boolean(
    config && hosted?.enabled && hosted.validatedProviders.includes(config.provider)
    && hosted.credential !== "none" && hosted.encryptionReady,
  );
  const primaryNodeName = routing?.primary.kind === "node" ? routing.primary.node : "";
  const routeReady = routing?.primary.kind === "config"
    ? hostedCanRun(selectedConfig)
    : routing?.primary.kind === "node"
      ? persistentNodes.some((node) => (node.name || node.id) === primaryNodeName && node.online) || hostedCanRun(fallbackConfig)
      : persistentNodes.some((node) => node.online);

  return (
    <>
      <div className={`routing-readiness ${routeReady ? "ready" : "warn"}`} role="status">
        <div className="routing-readiness-copy">
          <strong>{routing === null ? "Checking run readiness…" : routeReady ? "Ready for unattended runs" : "Setup needs attention"}</strong>
          <span>
            {routing === null
              ? "Loading machines, routing, and credential status."
              : routing.primary.kind === "config"
              ? routeReady
                ? `${selectedConfig?.name || "Isolated profile"} can start without an online personal machine.`
                : "Ephemeral-only runs need hosted provisioning, a validated cloud credential, and GitHub/model sign-ins available to the fresh runner."
              : routing.primary.kind === "node"
                ? "The selected persistent machine must be online, or have an isolated fallback."
                : "The shared queue needs at least one online persistent machine."}
          </span>
        </div>
        {routing !== null && !routeReady && onConfigureCredentials && (
          <button type="button" className="btn sm" onClick={onConfigureCredentials}>Fix setup</button>
        )}
      </div>

      <label className="field-label"><span>Primary machine</span>
        <select className="picker-search" value={primaryValue} disabled={busy} onChange={(e) => saveRouting(e.target.value, fallbackValue)}>
          <option value="shared">Shared queue (any online machine)</option>
          {persistentNodes.length > 0 && (
            <optgroup label="Trusted workstations">
              {persistentNodes.map((n) => (
                <option key={n.id} value={`node:${n.name || n.id}`}>{n.name || n.id}</option>
              ))}
            </optgroup>
          )}
          {configs.length > 0 && (
            <optgroup label="Isolated machine profiles">
              {configs.map((c) => (
                <option key={c.id} value={`config:${c.id}`}>{c.name} · {c.provider}</option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {primaryIsNode && (
        <label className="field-label"><span>Fallback if machine is offline</span>
          <select className="picker-search" value={fallbackValue} disabled={busy} onChange={(e) => saveRouting(primaryValue, e.target.value)}>
            <option value="">None — wait for the machine</option>
            {configs.map((c) => (
              <option key={c.id} value={`config:${c.id}`}>{c.name} · {c.provider}</option>
            ))}
          </select>
        </label>
      )}
      <p className="muted small">
        {primaryIsNode
          ? "Runs wait for this machine; if it's offline and a fallback is set, a fresh isolated machine is provisioned instead."
          : routing?.primary.kind === "config"
            ? "Every run starts from this isolated profile. Cloud credentials authorize machine creation; GitHub credentials clone and push; model credentials authorize the agent. These sign-ins are separate and secret values are never shown here."
            : "Runs are picked up by any online persistent machine. No cloud credential is needed."}
      </p>

      <h4 className="settings-subhead">Isolated machine profiles</h4>
      {draft ? (
        <div className="settings-form">
          <label className="field-label"><span>Name</span>
            <input className="picker-search" value={draft.name} placeholder="e.g. fly-small-iad" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="field-label"><span>Provider</span>
            <select className="picker-search" value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value })}>
              <option value="" disabled>Choose a provider</option>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>{k.name}{k.configured ? "" : " (no token on this device)"}</option>
              ))}
            </select>
          </label>
          <label className="field-label"><span>Region (optional)</span>
            <input className="picker-search" value={draft.region} placeholder="provider default" onChange={(e) => setDraft({ ...draft, region: e.target.value })} />
          </label>
          <label className="field-label"><span>Server type (optional)</span>
            <input className="picker-search" value={draft.size} placeholder="provider default" onChange={(e) => setDraft({ ...draft, size: e.target.value })} />
          </label>
          <label className="field-label"><span>Auto-destroy after</span>
            <select className="picker-search" value={draft.ttlMinutes ?? ""} onChange={(e) => setDraft({ ...draft, ttlMinutes: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Provider default</option>
              {QUEUE_TTL_OPTIONS.map((o) => (<option key={o.v} value={o.v}>{o.label}</option>))}
            </select>
          </label>
          <div className="settings-toggle-row">
            <div className="settings-toggle-text">
              <span className="settings-toggle-title">Destroy after the agent finishes</span>
              <span className="muted small">Tear the machine down on agent_end; the TTL stays a safety fallback.</span>
            </div>
            <Toggle checked={draft.teardownOnAgentFinish} onChange={(v) => setDraft({ ...draft, teardownOnAgentFinish: v })} label="Destroy after the agent finishes" />
          </div>
          <div className="settings-toggle-row">
            <div className="settings-toggle-text">
              <span className="settings-toggle-title">Keep one machine ready</span>
              <span className="muted small">Starts an account-owned machine before a Run arrives for faster startup. It may incur idle provider charges and remains bounded by the TTL.</span>
            </div>
            <Toggle checked={draft.readyCapacity && readyCapacityEligible} disabled={!readyCapacityEligible} onChange={(v) => setDraft({ ...draft, readyCapacity: v })} label="Keep one machine ready" />
          </div>
          {!readyCapacityEligible && <p className="muted small">Managed-compute providers use their native fast-start or suspend path instead of Bivy ready capacity.</p>}
          <div className="row-actions">
            <button className="btn primary" disabled={busy || !draft.name.trim() || !draft.provider} onClick={saveConfig}>
              {busy ? "Saving…" : draft.editing ? "Save changes" : "Add profile"}
            </button>
            <button className="btn" onClick={() => { setErr(null); setDraft(null); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div className="picker-list">
            {configs.length === 0 && <div className="picker-empty">No isolated machine profiles yet.</div>}
            {configs.map((c) => (
              <PickerItem
                key={c.id}
                title={c.name}
                meta={`${providerName(c.provider)}${c.region ? " · " + c.region : ""}${c.size ? " · " + c.size : ""}${c.ttlMinutes ? " · " + c.ttlMinutes + "m" : ""}${c.readyCapacity ? " · 1 ready" : ""}${providerReady(c.provider) ? "" : " · no token here"}`}
                right={<button className="btn danger-ghost sm" onClick={(e) => { e.stopPropagation(); setConfirmRemove(c); }}>Remove</button>}
                onClick={() => { setErr(null); setDraft({ editing: c.id, name: c.name, provider: c.provider, region: c.region ?? "", size: c.size ?? "", ttlMinutes: c.ttlMinutes ?? null, readyCapacity: Boolean(c.readyCapacity), teardownOnAgentFinish: Boolean(c.teardownOnAgentFinish) }); }}
              />
            ))}
          </div>
          <button className="btn primary block" onClick={() => { setErr(null); setDraft({ name: "", provider: keys[0]?.id ?? "", region: "", size: "", ttlMinutes: null, readyCapacity: false, teardownOnAgentFinish: false }); }}>+ Add profile</button>
        </>
      )}
      {err && <Badge tone="danger">{err}</Badge>}
      {confirmRemove && (
        <ConfirmDialog
          title="Remove profile?"
          message={`Remove ${confirmRemove.name}? Runs assigned to it will fall back to the shared queue.`}
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => removeConfig(confirmRemove)}
        />
      )}
    </>
  );
}
