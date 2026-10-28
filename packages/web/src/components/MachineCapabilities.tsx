// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import { describeCapabilityState, type CapabilityAgentSummary, type CapabilityPluginSummary, type CapabilityState } from "@bivy/core";
import { useAppState, controller } from "../store/useStore.js";
import { Badge } from "./Badge.js";

function StateChip({ state }: { state: CapabilityState }) {
  const tone = state === "available" ? "ok" : state === "unknown" ? "warn" : undefined;
  return <Badge tone={tone}>{describeCapabilityState(state)}</Badge>;
}

function AgentRow({ agent }: { agent: CapabilityAgentSummary }) {
  return (
    <div className="settings-toggle-row">
      <span>{agent.label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {agent.supportTier && <span className="muted small">{agent.supportTier}</span>}
        <Badge tone={agent.installed ? "ok" : undefined}>{agent.installed ? "Installed" : "Not installed"}</Badge>
      </span>
    </div>
  );
}

/** "2 widgets · 1 tool · theme Dusk": what a plugin is for, in a line. */
function pluginAdds(plugin: CapabilityPluginSummary): string {
  const count = (n: number, one: string) => (n ? `${n} ${one}${n === 1 ? "" : "s"}` : "");
  const c = plugin.contributions;
  return [
    count(plugin.agentCount, "agent"),
    count(c?.widgets ?? 0, "widget"),
    count(c?.tools ?? 0, "tool"),
    count(c?.guides ?? 0, "guide"),
    ...(c?.themes ?? []).map((theme) => `theme ${theme.name}`),
  ].filter(Boolean).join(" · ");
}

/**
 * What agents installed on this machine, and the two things a person can do
 * about it here: remove one, and choose a plugin's theme. Installing is left
 * to agents and the CLI (`bivy guide extend-bivy`).
 */
function PluginRows({ plugins, theme, online, onChanged }: { plugins: CapabilityPluginSummary[]; theme: string | null; online: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const themes = plugins.flatMap((plugin) => plugin.contributions?.themes ?? []);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  return (
    <>
      <h4 className="settings-subhead">Plugins</h4>
      {plugins.length === 0 && (
        <p className="muted small">None yet. Ask any agent for a widget, a tool, a theme or a playbook, and it builds a plugin for this machine.</p>
      )}
      {plugins.map((plugin) => (
        <div className="settings-toggle-row" key={plugin.id}>
          <span>
            {plugin.name ?? plugin.id}
            {plugin.version && <span className="muted small"> {plugin.version}</span>}
            <span className="muted small" style={{ display: "block" }}>{plugin.valid ? pluginAdds(plugin) || "Nothing to add" : "Not loaded: run bivy plugin list on the machine to see why"}</span>
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            {!plugin.valid && <Badge tone="warn">Invalid</Badge>}
            {confirming === plugin.id ? (
              <>
                <button className="btn ghost" disabled={busy !== null} onClick={() => setConfirming(null)}>Keep</button>
                <button className="btn danger" disabled={!online || busy !== null} onClick={() => void run(plugin.id, () => controller.pluginCommand("plugins.remove", { id: plugin.id }))}>
                  {busy === plugin.id ? "Removing…" : "Remove"}
                </button>
              </>
            ) : (
              <button className="btn" disabled={!online || busy !== null} aria-label={`Remove ${plugin.name ?? plugin.id}`} onClick={() => setConfirming(plugin.id)}>Remove</button>
            )}
          </span>
        </div>
      ))}
      {themes.length > 0 && (
        <div className="settings-toggle-row">
          <label htmlFor="plugin-theme">Theme</label>
          <select
            id="plugin-theme"
            className="picker-search"
            style={{ width: "auto" }}
            value={theme ?? ""}
            disabled={!online || busy !== null}
            onChange={(event) => void run("theme", () => controller.pluginCommand("plugins.theme", { id: event.target.value || null }))}
          >
            <option value="">The machine's own</option>
            {themes.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </div>
      )}
      {error && <p className="muted small" role="alert">{error}</p>}
    </>
  );
}

/**
 * The Machine capability inventory (Settings → Machines): what this Machine
 * unlocks for agents — OS/architecture, installed maintained/custom agents,
 * configured model providers/local endpoints, Docker/GPU availability,
 * installed plugins, and a bounded workspace count. Capability discovery, not
 * a live resource monitor: fetched on mount and on explicit refresh only
 * (unlike the Node stats panel, which polls) since this data changes rarely.
 */
export function MachineCapabilitiesSection({ online }: { online: boolean }) {
  const { settings: { capabilities } } = useAppState();
  const [loading, setLoading] = useState(false);

  const refresh = () => {
    if (!online) return;
    setLoading(true);
    controller.requestCapabilities();
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (online) refresh(); }, [online]);
  useEffect(() => { if (capabilities) setLoading(false); }, [capabilities]);

  const agents = capabilities ? [...capabilities.agents.maintained, ...capabilities.agents.custom] : [];
  const installedCount = agents.filter((a) => a.installed).length;

  return (
    <section className="settings-section">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h4 className="settings-subhead">Capabilities</h4>
        <button className="btn" disabled={!online || loading} onClick={refresh}>{loading ? "Refreshing…" : "Refresh"}</button>
      </div>

      {!online && <p className="muted small">Connect this machine to see what it unlocks for agents.</p>}
      {online && !capabilities && <p className="muted small">{loading ? "Loading capabilities…" : "No capability data yet."}</p>}

      {capabilities && (
        <>
          <div className="settings-toggle-row">
            <span>Operating system</span>
            <span className="muted small">{capabilities.os.platform} {capabilities.os.arch} · {capabilities.os.release}</span>
          </div>
          <div className="settings-toggle-row">
            <span>Docker</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {capabilities.docker.detail && <span className="muted small">{capabilities.docker.detail}</span>}
              <StateChip state={capabilities.docker.state} />
            </span>
          </div>
          <div className="settings-toggle-row">
            <span>GPU</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {capabilities.gpu.detail && <span className="muted small">{capabilities.gpu.detail}</span>}
              <StateChip state={capabilities.gpu.state} />
            </span>
          </div>

          <h4 className="settings-subhead">Agents ({installedCount}/{agents.length} installed)</h4>
          {agents.length === 0 && <p className="muted small">No agents known to this machine.</p>}
          {capabilities.agents.maintained.map((a) => <AgentRow key={a.id} agent={a} />)}
          {capabilities.agents.custom.length > 0 && (
            <>
              <p className="muted small">Custom</p>
              {capabilities.agents.custom.map((a) => <AgentRow key={a.id} agent={a} />)}
            </>
          )}

          <div className="settings-toggle-row">
            <span>Model providers configured</span>
            <span className="muted small">{capabilities.providers.configured.length ? capabilities.providers.configured.join(", ") : "None"}</span>
          </div>
          <div className="settings-toggle-row">
            <span>Local model endpoints</span>
            <span className="muted small">
              {capabilities.providers.localEndpoints.count} configured
              {capabilities.providers.localEndpoints.count > 0 ? ` (${capabilities.providers.localEndpoints.withModels} with models)` : ""}
            </span>
          </div>
          <div className="settings-toggle-row">
            <span>Workspaces configured</span>
            <span className="muted small">{capabilities.workspaces.count}</span>
          </div>

          <PluginRows plugins={capabilities.plugins} theme={capabilities.theme ?? null} online={online} onChanged={refresh} />

          <p className="muted small">Updated {new Date(capabilities.generatedAt).toLocaleTimeString()}.</p>
        </>
      )}
    </section>
  );
}
