// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The other machines on your tailnet that run Bivy, so a machine reached over
// Tailscale can offer the rest. Tailscale lists the peers; each is asked for
// Bivy's hello at its tailnet address, which only answers where `bivy
// tailscale` is on.
import { execFile } from "node:child_process";

export interface TailnetPeer {
  /** Tailnet name, e.g. `desktop.tail1234.ts.net`. */
  dnsName: string;
  hostName: string;
  online: boolean;
  os?: string;
}

export interface TailnetMachine {
  name: string;
  url: string;
  nodeId?: string;
  os?: string;
  online: boolean;
  /** The machine answering the request. */
  self: boolean;
}

/** Peers from `tailscale status --json`, without the machine itself. */
export function parseTailnetPeers(text: string): TailnetPeer[] {
  let status: { Peer?: Record<string, { DNSName?: string; HostName?: string; Online?: boolean; OS?: string }> };
  try { status = JSON.parse(text); } catch { return []; }
  return Object.values(status?.Peer ?? {})
    .map((p) => ({ dnsName: String(p.DNSName ?? "").replace(/\.$/, ""), hostName: String(p.HostName ?? ""), online: p.Online === true, os: p.OS }))
    .filter((p) => p.dnsName.endsWith(".ts.net"));
}

function tailscaleStatus(): Promise<string> {
  return new Promise((resolve) => {
    execFile("tailscale", ["status", "--json"], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : stdout));
  });
}

async function hello(peer: TailnetPeer, fetchImpl: typeof fetch): Promise<TailnetMachine | null> {
  try {
    const res = await fetchImpl(`https://${peer.dnsName}/api/direct/hello`, { signal: AbortSignal.timeout(2500) });
    const body = await res.json() as { bivy?: unknown; name?: unknown; nodeId?: unknown };
    if (!res.ok || body?.bivy !== true) return null;
    return { name: typeof body.name === "string" && body.name ? body.name : peer.hostName, url: `https://${peer.dnsName}`, nodeId: typeof body.nodeId === "string" ? body.nodeId : undefined, os: peer.os, online: true, self: false };
  } catch {
    return null;
  }
}

/** Online tailnet peers running Bivy over Tailscale. Offline peers aren't asked. */
export async function discoverTailnetMachines(deps: { status?: () => Promise<string>; fetchImpl?: typeof fetch } = {}): Promise<TailnetMachine[]> {
  const peers = parseTailnetPeers(await (deps.status ?? tailscaleStatus)()).filter((p) => p.online);
  const found = await Promise.all(peers.map((p) => hello(p, deps.fetchImpl ?? fetch)));
  return found.filter((m): m is TailnetMachine => m !== null).sort((a, b) => a.name.localeCompare(b.name));
}
