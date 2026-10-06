// SPDX-License-Identifier: AGPL-3.0-only
// Account-level queue routing: where queued automation work runs. The shared
// queue (any online machine), one of your machines, or — when the deployment
// provides one — its cloud ("Bivy Cloud"), which starts a Machine on demand. A
// machine primary may fall back to the deployment's cloud while it's offline.
// Rendered by the Automations hub's Work Queue tab; gated by
// EPHEMERAL_MACHINES_ENABLED.
import { useEffect, useState } from "react";
import type { AccountNode, EphemeralNodeConfig, HostedProvisioningStatus, QueueRouting } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { Badge } from "./Badge.js";

export function QueueRoutingSection({
  hosted,
  onConfigureCredentials,
}: {
  hosted?: HostedProvisioningStatus | null;
  onConfigureCredentials?: () => void;
}) {
  const [nodes, setNodes] = useState<AccountNode[]>([]);
  const [clouds, setClouds] = useState<EphemeralNodeConfig[]>([]);
  const [routing, setRouting] = useState<QueueRouting | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    controller.listNodes().then(setNodes).catch(() => {});
    controller.getQueueRouting().then(setRouting).catch(() => setRouting(null));
    controller.listEphemeralConfigs()
      .then((configs) => setClouds(configs.filter((config) => config.computeSource === "managed")))
      .catch(() => {});
  }, []);

  const persistentNodes = nodes.filter((n) => !n.id.startsWith("eph-"));
  const primaryValue = routing?.primary.kind === "node" ? `node:${routing.primary.node}`
    : routing?.primary.kind === "config" ? `config:${routing.primary.configId}` : "shared";
  const fallbackValue = routing?.fallback?.kind === "config" ? `config:${routing.fallback.configId}` : "";
  const primaryIsNode = routing?.primary.kind === "node";

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

  const cloudFor = (configId?: string) => (configId ? clouds.find((c) => c.id === configId) : undefined);
  const selectedCloud = cloudFor(routing?.primary.kind === "config" ? routing.primary.configId : undefined);
  const fallbackCloud = cloudFor(routing?.fallback?.configId);
  const cloudCanRun = (config?: EphemeralNodeConfig) => Boolean(
    config && hosted?.execution.ready && (!hosted.execution.configId || hosted.execution.configId === config.id),
  );
  const primaryNodeName = routing?.primary.kind === "node" ? routing.primary.node : "";
  const routeReady = routing?.primary.kind === "config"
    ? cloudCanRun(selectedCloud)
    : routing?.primary.kind === "node"
      ? persistentNodes.some((node) => (node.name || node.id) === primaryNodeName && node.online) || cloudCanRun(fallbackCloud)
      : persistentNodes.some((node) => node.online);

  // What happens to the next run, in words: where it goes when ready, what's
  // missing when not.
  const routingDetail = (): string => {
    if (routing === null) return "Loading machines, routing, and credential status.";
    if (routing.primary.kind === "config") {
      return routeReady
        ? `Each run starts on ${selectedCloud?.name || "the cloud"}; none of your machines need to be online.`
        : "Cloud runs need GitHub and model sign-ins that the cloud machine can use while you're away.";
    }
    if (routing.primary.kind === "node") {
      const online = persistentNodes.some((node) => (node.name || node.id) === primaryNodeName && node.online);
      if (online) return `Runs go to ${primaryNodeName}.`;
      return routeReady
        ? `${primaryNodeName} is offline, so runs go to ${fallbackCloud?.name || "the cloud"} until it's back.`
        : `Runs wait until ${primaryNodeName} is online.`;
    }
    return routeReady ? "Runs go to whichever of your machines is online." : "Runs wait until one of your machines is online.";
  };

  return (
    <>
      <div className="banner routing-status" data-tone={routeReady ? "ok" : "warn"} role="status">
        <div className="banner-text routing-status-copy">
          <strong>{routing === null ? "Checking run readiness…" : routeReady ? "Ready for unattended runs" : "Setup needs attention"}</strong>
          <span>{routingDetail()}</span>
        </div>
        {routing !== null && !routeReady && onConfigureCredentials && (
          <button type="button" className="btn sm" onClick={onConfigureCredentials}>Fix setup</button>
        )}
      </div>

      <label className="field-label"><span>Runs on</span>
        <select className="picker-search" value={primaryValue} disabled={busy} onChange={(e) => saveRouting(e.target.value, fallbackValue)}>
          <option value="shared">Any of your online machines</option>
          {persistentNodes.length > 0 && (
            <optgroup label="Your machines">
              {persistentNodes.map((n) => (
                <option key={n.id} value={`node:${n.name || n.id}`}>{n.name || n.id}</option>
              ))}
            </optgroup>
          )}
          {clouds.map((c) => (
            <option key={c.id} value={`config:${c.id}`}>{c.name}</option>
          ))}
        </select>
      </label>
      {primaryIsNode && clouds.length > 0 && (
        <label className="field-label"><span>If that machine is offline</span>
          <select className="picker-search" value={fallbackValue} disabled={busy} onChange={(e) => saveRouting(primaryValue, e.target.value)}>
            <option value="">Wait for the machine</option>
            {clouds.map((c) => (
              <option key={c.id} value={`config:${c.id}`}>Run on {c.name}</option>
            ))}
          </select>
        </label>
      )}
      {err && <Badge tone="danger">{err}</Badge>}
    </>
  );
}
