// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { EphemeralNodeConfig, HostedMachineSummary } from "@bivy/core";

/** One row in the machine picker for a cloud profile or a running cloud Machine.
 * `nodeId` set → picking it reuses that running Machine; unset → the profile
 * launches a Machine when the first message is sent. */
export interface CloudDestination {
  key: string;
  label: string;
  online: boolean;
  nodeId?: string;
  config?: EphemeralNodeConfig;
}

interface NodeLike { id: string; online?: boolean }

const displayName = (name: string | undefined, fallback: string) => (name || fallback).replace(/^Hosted\s+/i, "");

/**
 * The picker's cloud rows. A managed profile is ONE destination — "Bivy Cloud"
 * — that reuses its newest running Machine and otherwise starts one on demand,
 * so the user never chooses between a template and its instances. BYO profiles
 * stay launch templates, with their running Machines listed for reuse.
 */
export function cloudDestinations(
  configs: EphemeralNodeConfig[],
  machines: HostedMachineSummary[],
  nodes: NodeLike[],
): { managed: CloudDestination[]; running: CloudDestination[]; templates: CloudDestination[] } {
  const live = machines
    .filter((machine) => machine.purpose === "interactive" && machine.desiredState !== "deleted" && machine.nodeId)
    .filter((machine) => nodes.some((node) => node.id === machine.nodeId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const online = (nodeId?: string) => Boolean(nodes.find((node) => node.id === nodeId)?.online);
  const claimed = new Set<string>();
  const managed = configs.filter((config) => config.computeSource === "managed").map((config) => {
    const reuse = live.find((machine) => machine.setupId === config.id && online(machine.nodeId));
    if (reuse) claimed.add(reuse.id);
    return { key: config.id, label: displayName(config.name, "Bivy Cloud"), online: Boolean(reuse), nodeId: reuse?.nodeId, config };
  });
  const managedIds = new Set(managed.map((row) => row.key));
  const running = live
    .filter((machine) => !claimed.has(machine.id) && !(machine.setupId && managedIds.has(machine.setupId)))
    .map((machine) => {
      const profile = configs.find((config) => config.id === machine.setupId);
      return { key: machine.id, label: displayName(profile?.name || machine.name, "Cloud machine"), online: online(machine.nodeId), nodeId: machine.nodeId };
    });
  const templates = configs.filter((config) => config.computeSource !== "managed")
    .map((config) => ({ key: config.id, label: config.name, online: false, config }));
  return { managed, running, templates };
}
