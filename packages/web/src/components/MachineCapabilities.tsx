// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import { describeCapabilityState, type CapabilityAgentSummary, type CapabilityState } from "@bivy/core";
import { useAppState, controller } from "../store/useStore.js";

function StateChip({ state }: { state: CapabilityState }) {
  const cls = state === "available" ? "chip ok" : state === "unknown" ? "chip warn" : "chip";
  return <span className={cls}>{describeCapabilityState(state)}</span>;
}

function AgentRow({ agent }: { agent: CapabilityAgentSummary }) {
  return (
    <div className="settings-toggle-row">
      <span>{agent.label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {agent.supportTier && <span className="muted small">{agent.supportTier}</span>}
        <span className={`chip${agent.installed ? " ok" : ""}`}>{agent.installed ? "Installed" : "Not installed"}</span>
      </span>
    </div>
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
  const { capabilities } = useAppState();
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
            <span>Plugins</span>
            <span className="muted small">
              {capabilities.plugins.length === 0 ? "None installed" : `${capabilities.plugins.filter((p) => p.valid).length}/${capabilities.plugins.length} valid`}
            </span>
          </div>
          <div className="settings-toggle-row">
            <span>Workspaces configured</span>
            <span className="muted small">{capabilities.workspaces.count}</span>
          </div>

          <p className="muted small">Updated {new Date(capabilities.generatedAt).toLocaleTimeString()}.</p>
        </>
      )}
    </section>
  );
}
