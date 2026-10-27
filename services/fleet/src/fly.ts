// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Fly Machines adapter. Only what the fleet needs: one app per account, one
// volume, one machine. Every call is idempotent or tolerant of "already in
// that state", so reconcile loops can retry freely.
import { SIZES } from "./sizes.js";
import type { Machine, MachineProvider, MachineSpec, ProviderOptions } from "./provider.js";

const API = "https://api.machines.dev/v1";
const GRAPHQL = "https://api.fly.io/graphql";
export const VOLUME_NAME = "bivy_data";
export const VOLUME_PATH = "/data";

function guest(size: string) {
  const row = SIZES[size] ?? SIZES["shared-4x-8gb"]!;
  return { cpu_kind: row.cpuKind, cpus: row.vcpus, memory_mb: row.memoryMiB };
}

/** States a machine passes through while an update is applied. */
const UNSETTLED = new Set(["created", "updating", "replacing"]);

export class FlyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export class FlyClient implements MachineProvider {
  private org?: string;
  private metricsOrg?: string;

  private readonly settleTimeoutMs: number;
  private readonly settlePollMs: number;

  constructor(private readonly token: string, private readonly options: ProviderOptions & { fetchImpl?: FetchLike; settleTimeoutMs?: number; settlePollMs?: number } = {}) {
    this.org = options.org;
    this.settleTimeoutMs = options.settleTimeoutMs ?? 30_000;
    this.settlePollMs = options.settlePollMs ?? 500;
  }

  async ensureApp(app: string): Promise<void> {
    // Apps in one org share a private network by default; an account's own
    // network keeps other accounts' machines from reaching its ports or
    // listing it through `.internal` DNS.
    const res = await this.call("POST", `/apps`, { app_name: app, org_slug: await this.orgSlug(), network: app });
    if (res.status < 300) return;
    // Fly answers 422 "already been taken" (or 409) for an existing app.
    if (res.status === 409 || (res.status === 422 && /already been taken/i.test(res.text))) return;
    throw new FlyError(res.status, `create app: ${res.text.slice(0, 200)}`);
  }

  async ensureVolume(app: string, region: string, sizeGb: number): Promise<string> {
    const listed = await this.call("GET", `/apps/${app}/volumes`);
    const volumes = Array.isArray(listed.json) ? listed.json as Array<{ id?: string; name?: string; state?: string }> : [];
    const existing = volumes.find((v) => v.name === VOLUME_NAME && v.id && v.state !== "destroyed" && v.state !== "pending_destroy");
    if (existing?.id) return existing.id;
    const created = await this.call("POST", `/apps/${app}/volumes`, { name: VOLUME_NAME, region, size_gb: sizeGb, encrypted: true });
    const id = (created.json as { id?: string } | undefined)?.id;
    if (created.status >= 300 || !id) throw new FlyError(created.status, `create volume: ${created.text.slice(0, 200)}`);
    return id;
  }

  async createVolume(app: string, region: string, sizeGb: number, name: string): Promise<string> {
    const created = await this.call("POST", `/apps/${app}/volumes`, { name, region, size_gb: sizeGb, encrypted: true });
    const id = (created.json as { id?: string } | undefined)?.id;
    if (created.status >= 300 || !id) throw new FlyError(created.status, `create volume: ${created.text.slice(0, 200)}`);
    return id;
  }

  /** Delete one machine and its volume, leaving the app. Absence is success. */
  async destroyMachine(app: string, machineId?: string, volumeId?: string): Promise<void> {
    if (machineId) {
      const res = await this.call("DELETE", `/apps/${app}/machines/${machineId}?force=true`);
      if (res.status >= 300 && res.status !== 404) throw new FlyError(res.status, `delete machine: ${res.text.slice(0, 200)}`);
    }
    if (volumeId) {
      const res = await this.call("DELETE", `/apps/${app}/volumes/${volumeId}`);
      if (res.status >= 300 && res.status !== 404) throw new FlyError(res.status, `delete volume: ${res.text.slice(0, 200)}`);
    }
  }

  /** Grow a volume. Fly can't shrink one. When `needsRestart`, a running
   * machine sees the new space after its next start. */
  async extendVolume(app: string, volumeId: string, sizeGb: number): Promise<{ needsRestart: boolean }> {
    const res = await this.call("PUT", `/apps/${app}/volumes/${volumeId}/extend`, { size_gb: sizeGb });
    if (res.status >= 300) throw new FlyError(res.status, `extend volume: ${res.text.slice(0, 200)}`);
    return { needsRestart: Boolean((res.json as { needs_restart?: boolean } | undefined)?.needs_restart) };
  }

  async createMachine(app: string, spec: MachineSpec): Promise<Machine> {
    const res = await this.call("POST", `/apps/${app}/machines`, { region: spec.region, config: this.config(spec) });
    if (res.status >= 300) throw new FlyError(res.status, `create machine: ${res.text.slice(0, 200)}`);
    return toMachine(res.json);
  }

  async updateMachine(app: string, machineId: string, spec: MachineSpec): Promise<Machine> {
    // skip_launch keeps a stopped machine stopped; the caller starts it.
    const res = await this.call("POST", `/apps/${app}/machines/${machineId}`, { region: spec.region, config: this.config(spec), skip_launch: true });
    if (res.status >= 300) throw new FlyError(res.status, `update machine: ${res.text.slice(0, 200)}`);
    // The update leaves the machine "created" while Fly applies it, and Fly
    // refuses to start it from there (412). Wait until it settles.
    return this.settled(app, machineId, toMachine(res.json));
  }

  private async settled(app: string, machineId: string, machine: Machine): Promise<Machine> {
    const deadline = Date.now() + this.settleTimeoutMs;
    let current: Machine | null = machine;
    while (current && UNSETTLED.has(current.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.settlePollMs));
      current = await this.getMachine(app, machineId);
    }
    if (!current) throw new FlyError(404, "update machine: the machine is gone");
    return current;
  }

  async getMachine(app: string, machineId: string): Promise<Machine | null> {
    const res = await this.call("GET", `/apps/${app}/machines/${machineId}`);
    if (res.status === 404) return null;
    if (res.status >= 300) throw new FlyError(res.status, `get machine: ${res.text.slice(0, 200)}`);
    const machine = toMachine(res.json);
    return machine.state === "destroyed" ? null : machine;
  }

  async startMachine(app: string, machineId: string): Promise<void> {
    const res = await this.call("POST", `/apps/${app}/machines/${machineId}/start`);
    if (res.status < 300) return;
    // Starting a machine that is already running is fine.
    const current = await this.getMachine(app, machineId);
    if (current && (current.state === "started" || current.state === "starting")) return;
    throw new FlyError(res.status, `start machine: ${res.text.slice(0, 200)}`);
  }

  async stopMachine(app: string, machineId: string): Promise<void> {
    const res = await this.call("POST", `/apps/${app}/machines/${machineId}/stop`);
    if (res.status < 300) return;
    const current = await this.getMachine(app, machineId);
    if (!current || current.state === "stopped" || current.state === "stopping" || current.state === "suspended") return;
    throw new FlyError(res.status, `stop machine: ${res.text.slice(0, 200)}`);
  }

  async busyApps(prefix: string, minutes: number, fraction: number): Promise<string[]> {
    const selector = `app=~"${prefix}.*"`;
    const window = `${Math.round(minutes)}m`;
    const query = `sum by (app) (rate(fly_instance_cpu{${selector},mode!~"idle|steal"}[${window}])) / sum by (app) (rate(fly_instance_cpu{${selector}}[${window}])) >= ${fraction}`;
    return (await this.metrics(query)).map((s) => s.metric?.app ?? "").filter(Boolean);
  }

  /** Bytes used and total on the app's data disk, as of when it last ran.
   * The guest only reports its filesystem while awake; Fly keeps about 15
   * days of metrics, so a machine asleep longer has no reading. */
  async diskUsage(app: string): Promise<{ usedBytes: number; totalBytes: number } | null> {
    const selector = `app="${app}",mount="${VOLUME_PATH}"`;
    const last = (metric: string) => `max by (app) (last_over_time(${metric}{${selector}}[15d]))`;
    const [used, total] = await Promise.all([
      this.metrics(`(${last("fly_instance_filesystem_blocks")} - ${last("fly_instance_filesystem_blocks_free")}) * ${last("fly_instance_filesystem_block_size")}`),
      this.metrics(`${last("fly_instance_filesystem_blocks")} * ${last("fly_instance_filesystem_block_size")}`),
    ]);
    const value = (series: typeof used) => Number(series[0]?.value?.[1]);
    if (!Number.isFinite(value(used)) || !Number.isFinite(value(total)) || value(total) <= 0) return null;
    return { usedBytes: value(used), totalBytes: value(total) };
  }

  private async metrics(query: string): Promise<Array<{ metric?: { app?: string }; value?: [number, string] }>> {
    // Fly's metrics name a personal org "personal" rather than by its slug.
    const orgs = this.metricsOrg ? [this.metricsOrg] : [await this.orgSlug(), "personal"];
    let res = { status: 0, text: "", json: undefined as unknown };
    for (const org of orgs) {
      res = await this.raw(`https://api.fly.io/prometheus/${encodeURIComponent(org)}/api/v1/query?query=${encodeURIComponent(query)}`, "GET");
      if (res.status < 300) { this.metricsOrg = org; break; }
      if (!/resolving organization/i.test(res.text)) break;
    }
    if (res.status >= 300) throw new FlyError(res.status, `query metrics: ${res.text.slice(0, 200)}`);
    return (res.json as { data?: { result?: Array<{ metric?: { app?: string }; value?: [number, string] }> } })?.data?.result ?? [];
  }

  async listApps(prefix: string): Promise<string[]> {
    const res = await this.call("GET", `/apps?org_slug=${encodeURIComponent(await this.orgSlug())}`);
    if (res.status >= 300) throw new FlyError(res.status, `list apps: ${res.text.slice(0, 200)}`);
    const apps = (res.json as { apps?: Array<{ name?: string }> } | undefined)?.apps ?? [];
    return apps.map((app) => app.name ?? "").filter((name) => name.startsWith(prefix));
  }

  async destroyAll(app: string, machineId?: string): Promise<void> {
    if (machineId) {
      const res = await this.call("DELETE", `/apps/${app}/machines/${machineId}?force=true`);
      if (res.status >= 300 && res.status !== 404) throw new FlyError(res.status, `delete machine: ${res.text.slice(0, 200)}`);
    }
    const volumes = await this.call("GET", `/apps/${app}/volumes`);
    if (volumes.status === 404) return;
    for (const volume of Array.isArray(volumes.json) ? volumes.json as Array<{ id?: string }> : []) {
      if (!volume.id) continue;
      const res = await this.call("DELETE", `/apps/${app}/volumes/${volume.id}`);
      if (res.status >= 300 && res.status !== 404) throw new FlyError(res.status, `delete volume: ${res.text.slice(0, 200)}`);
    }
    const res = await this.call("DELETE", `/apps/${app}`);
    if (res.status >= 300 && res.status !== 404) throw new FlyError(res.status, `delete app: ${res.text.slice(0, 200)}`);
  }

  private config(spec: MachineSpec) {
    return {
      image: spec.image,
      // The node stops itself when quiet; the machine and its volume remain.
      auto_destroy: false,
      restart: { policy: "no" },
      guest: guest(spec.size),
      metadata: spec.metadata,
      files: spec.files,
      init: spec.init,
      mounts: [{ volume: spec.volumeId, path: VOLUME_PATH }],
    };
  }

  private async orgSlug(): Promise<string> {
    if (this.org) return this.org;
    const res = await this.raw(GRAPHQL, "POST", { query: "query { organizations { nodes { slug type } } }" });
    const nodes = ((res.json as { data?: { organizations?: { nodes?: Array<{ slug?: string; type?: string }> } } })?.data?.organizations?.nodes) ?? [];
    const chosen = nodes.find((o) => String(o.type).toUpperCase() === "PERSONAL" && o.slug) ?? nodes.find((o) => o.slug);
    if (!chosen?.slug) throw new FlyError(res.status, "Fly token has no accessible organization");
    this.org = chosen.slug;
    return this.org;
  }

  private call(method: string, path: string, body?: unknown) {
    return this.raw(`${API}${path}`, method, body);
  }

  private async raw(url: string, method: string, body?: unknown): Promise<{ status: number; text: string; json: unknown }> {
    const fetchImpl: FetchLike = this.options.fetchImpl ?? (fetch as unknown as FetchLike);
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, text, json };
  }
}

function toMachine(value: unknown): Machine {
  const m = (value ?? {}) as { id?: string; state?: string; region?: string; created_at?: string; config?: { image?: string } };
  if (!m.id) throw new FlyError(500, "Fly returned no machine");
  return { id: m.id, state: m.state ?? "unknown", region: m.region ?? "", image: m.config?.image, createdAt: m.created_at };
}
