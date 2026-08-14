// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Hetzner provider interpreter.
import type { EphemeralMachine } from "../ephemeral-machine.js";
import type { ExecFn, ProviderAdapter } from "../ephemeral-provider-ports.js";
import { bearer, call, memoizeByKey, nowIso, providerError } from "../ephemeral-provider-utils.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

function mapHetznerStatus(s: string): string {
  return s === "running" ? "running" : s === "off" || s === "stopping" ? "stopped" : "starting";
}

interface HetznerSize {
  typeId: number;
  id: string;
  label: string;
  cores: number;
  memory: number;
  pricePerHour?: number;
}

/** Pull an indicative hourly gross price (EUR) from a Hetzner server_type's
 *  per-location `prices` array. Region prices differ slightly; the first entry
 *  is close enough for an at-a-glance hint. Returns undefined when absent. */
function hetznerHourlyPrice(t: any): number | undefined {
  const prices = Array.isArray(t?.prices) ? t.prices : [];
  for (const p of prices) {
    const gross = Number(p?.price_hourly?.gross);
    if (Number.isFinite(gross) && gross > 0) return gross;
  }
  return undefined;
}

// Hetzner's server-type catalog and datacenter availability are region-agnostic
// and change rarely, so fetch each once per token and reuse across region
// switches. Keyed by token; refreshed on a new page load.
const hetznerSizeCache = new Map<string, Promise<HetznerSize[]>>();
const hetznerAvailCache = new Map<string, Promise<Map<string, Set<number>>>>();

/** Non-deprecated server types (deprecated ones are dropped as un-orderable). */
function fetchHetznerSizes(exec: ExecFn, token: string): Promise<HetznerSize[]> {
  return memoizeByKey(hetznerSizeCache, token, async () => {
    const rows: HetznerSize[] = [];
    let url: string | null = "https://api.hetzner.cloud/v1/server_types?per_page=50";
    for (let guard = 0; url && guard < 10; guard++) {
      const res = await call(exec, { method: "GET", url, headers: bearer(token) });
      if (res.status >= 300) throw new Error(providerError(res, "list server types"));
      const types = Array.isArray(res.body?.server_types) ? res.body.server_types : [];
      for (const t of types) {
        if (t.deprecation) continue; // globally deprecated — no longer orderable
        const arch = t.architecture === "arm" ? "Arm64" : "x86";
        rows.push({
          typeId: Number(t.id),
          id: String(t.name),
          label: `${t.name} · ${t.cores} vCPU · ${t.memory} GB · ${t.disk} GB (${arch})`,
          cores: Number(t.cores) || 0,
          memory: Number(t.memory) || 0,
          pricePerHour: hetznerHourlyPrice(t),
        });
      }
      const next = res.body?.meta?.pagination?.next_page;
      url = next ? `https://api.hetzner.cloud/v1/server_types?per_page=50&page=${next}` : null;
    }
    return rows;
  });
}

/** Map of region (location name) → server-type ids orderable there right now. */
function fetchHetznerAvailability(exec: ExecFn, token: string): Promise<Map<string, Set<number>>> {
  return memoizeByKey(hetznerAvailCache, token, async () => {
    const byRegion = new Map<string, Set<number>>();
    let url: string | null = "https://api.hetzner.cloud/v1/datacenters?per_page=50";
    for (let guard = 0; url && guard < 10; guard++) {
      const res = await call(exec, { method: "GET", url, headers: bearer(token) });
      if (res.status >= 300) throw new Error(providerError(res, "list datacenters"));
      const dcs = Array.isArray(res.body?.datacenters) ? res.body.datacenters : [];
      for (const dc of dcs) {
        const region = dc?.location?.name;
        if (!region) continue;
        const set = byRegion.get(region) ?? new Set<number>();
        const avail = Array.isArray(dc?.server_types?.available) ? dc.server_types.available : [];
        for (const id of avail) set.add(Number(id));
        byRegion.set(region, set);
      }
      const next = res.body?.meta?.pagination?.next_page;
      url = next ? `https://api.hetzner.cloud/v1/datacenters?per_page=50&page=${next}` : null;
    }
    return byRegion;
  });
}

export const hetznerProvider: ProviderAdapter = {
  id: "hetzner",
  name: "Hetzner Cloud",
  currency: "EUR",
  regions: [
    { id: "nbg1", label: "Nuremberg" },
    { id: "fsn1", label: "Falkenstein" },
    { id: "hel1", label: "Helsinki" },
    { id: "ash", label: "Ashburn, VA" },
    { id: "hil", label: "Hillsboro, OR" },
  ],
  defaultRegion: "nbg1",
  // Only currently-orderable shared plans. The shared-Intel `cx` line (e.g.
  // cx22 = type id 104) was deprecated on 2026-01-01 and is intentionally
  // omitted — ordering it returns HTTP 422. cpx = AMD x86, cax = Arm64.
  // Prices are indicative hourly gross (EUR) for the cost hint; the live
  // `listSizes` fetch below overrides them with the token's real prices.
  sizes: [
    { id: "cpx11", label: "cpx11 · 2 vCPU · 2 GB · 40 GB (AMD x86)", pricePerHour: 0.007 },
    { id: "cpx21", label: "cpx21 · 3 vCPU · 4 GB · 80 GB (AMD x86)", pricePerHour: 0.013 },
    { id: "cpx31", label: "cpx31 · 4 vCPU · 8 GB · 160 GB (AMD x86)", pricePerHour: 0.026 },
    { id: "cpx41", label: "cpx41 · 8 vCPU · 16 GB · 240 GB (AMD x86)", pricePerHour: 0.049 },
    { id: "cpx51", label: "cpx51 · 16 vCPU · 32 GB · 360 GB (AMD x86)", pricePerHour: 0.099 },
    { id: "cax11", label: "cax11 · 2 vCPU · 4 GB · 40 GB (Arm64)", pricePerHour: 0.006 },
    { id: "cax21", label: "cax21 · 4 vCPU · 8 GB · 80 GB (Arm64)", pricePerHour: 0.012 },
    { id: "cax31", label: "cax31 · 8 vCPU · 16 GB · 160 GB (Arm64)", pricePerHour: 0.024 },
    { id: "cax41", label: "cax41 · 16 vCPU · 32 GB · 320 GB (Arm64)", pricePerHour: 0.048 },
  ],
  // x86, 4 GB — closest drop-in for the retired cx22, and x86 avoids the
  // Arm-compat pitfalls of the cax line for Docker images and binaries.
  defaultSize: "cpx21",
  // `shutdown -h now` only powers a Hetzner server off; billing continues until
  // the API resource is deleted. Hosted reconciliation supplies that authority.
  guestCanEnsureDeletion: false,
  async validateToken({ exec, token }) {
    const res = await call(exec, {
      method: "GET",
      url: "https://api.hetzner.cloud/v1/servers?per_page=1",
      headers: bearer(token),
    });
    if (res.status >= 300) throw new Error(providerError(res, "validate credential"));
  },
  async listSizes({ exec, token, region }) {
    // Live catalog minus anything Hetzner has deprecated (both memoized per
    // token, so switching region doesn't re-fetch).
    const rows = await fetchHetznerSizes(exec, token);
    // Narrow to what the chosen region can actually order — a plan can be
    // globally live yet unavailable in a given datacenter. Best-effort: if the
    // lookup fails or matches nothing, keep the un-narrowed list.
    let scoped = rows;
    if (region) {
      try {
        const set = (await fetchHetznerAvailability(exec, token)).get(region);
        const filtered = set ? rows.filter((r) => set.has(r.typeId)) : rows;
        if (filtered.length) scoped = filtered;
      } catch {
        // keep the un-narrowed live list rather than dropping to the static one
      }
    }
    return [...scoped]
      .sort((a, b) => a.cores - b.cores || a.memory - b.memory || a.id.localeCompare(b.id))
      .map(({ id, label, pricePerHour }) => ({ id, label, pricePerHour }));
  },
  async provision({ exec, token, config, userData }) {
    const name = `bivy-${config.slug}`;
    // Hetzner has no create idempotency token. The stable attempt label is the
    // recovery key: after a timeout, a retry adopts the accepted server instead
    // of issuing another paid create.
    if (config.attemptId) {
      const found = await call(exec, {
        method: "GET",
        url: `https://api.hetzner.cloud/v1/servers?label_selector=${encodeURIComponent(`bivy-attempt=${config.attemptId}`)}`,
        headers: bearer(token),
      });
      if (found.status < 300 && Array.isArray(found.body?.servers) && found.body.servers[0]) {
        const s = found.body.servers[0];
        return { id: String(s.id), provider: "hetzner", name, region: config.region || "nbg1", status: mapHetznerStatus(s.status), ip: s.public_net?.ipv4?.ip || null, createdAt: nowIso(), ttlMinutes: config.ttlMinutes };
      }
    }
    const res = await call(exec, {
      method: "POST",
      url: "https://api.hetzner.cloud/v1/servers",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: {
        name,
        server_type: config.size || hetznerProvider.defaultSize,
        image: config.image || "ubuntu-24.04",
        location: config.region || "nbg1",
        user_data: userData,
        start_after_create: true,
        labels: {
          bivy: "ephemeral",
          ...(config.attemptId ? { "bivy-attempt": String(config.attemptId) } : {}),
          ...(config.ownershipTag ? { "bivy-account": String(config.ownershipTag) } : {}),
        },
      },
    });
    if (res.status >= 300) throw new Error(providerError(res, "create server"));
    const s = res.body && res.body.server;
    if (!s) throw new Error("Hetzner did not return a server");
    return {
      id: String(s.id),
      provider: "hetzner",
      name,
      region: config.region || "nbg1",
      status: mapHetznerStatus(s.status),
      ip: s.public_net?.ipv4?.ip || null,
      createdAt: nowIso(),
      ttlMinutes: config.ttlMinutes,
    };
  },
  async status({ exec, token, machine }) {
    const res = await call(exec, {
      method: "GET",
      url: `https://api.hetzner.cloud/v1/servers/${encodeURIComponent(machine.id)}`,
      headers: bearer(token),
    });
    if (res.status === 404) return "gone";
    if (res.status >= 300) throw new Error(providerError(res, "get server"));
    return mapHetznerStatus(res.body?.server?.status);
  },
  async destroy({ exec, token, machine }) {
    const res = await call(exec, {
      method: "DELETE",
      url: `https://api.hetzner.cloud/v1/servers/${encodeURIComponent(machine.id)}`,
      headers: bearer(token),
    });
    if (res.status >= 300 && res.status !== 404) throw new Error(providerError(res, "delete server"));
  },
  async discover({ exec, token, ownershipTag }) {
    const res = await call(exec, {
      method: "GET",
      url: `https://api.hetzner.cloud/v1/servers?label_selector=${encodeURIComponent(`bivy-account=${ownershipTag}`)}`,
      headers: bearer(token),
    });
    if (res.status >= 300) throw new Error(providerError(res, "list servers"));
    const servers = Array.isArray(res.body?.servers) ? res.body.servers : [];
    return servers.map((s: any): EphemeralMachine => ({
      id: String(s.id),
      provider: "hetzner",
      name: String(s.name || ""),
      region: s.datacenter?.location?.name || "",
      status: mapHetznerStatus(s.status),
      ip: s.public_net?.ipv4?.ip || null,
      createdAt: typeof s.created === "string" ? s.created : "",
      attemptId: typeof s.labels?.["bivy-attempt"] === "string" ? s.labels["bivy-attempt"] : undefined,
    }));
  },
};
