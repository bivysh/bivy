// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Provider transport ports, bootstrap builders, and adapter implementations.
// All effects enter through the explicit ExecFn port; adapters hold no credential
// or orchestration globals.

import { b64 } from "./base64.js";
import { clampTtlMinutes, ephemeralCostEstimate as deriveEphemeralCostEstimate } from "./ephemeral-lifecycle.js";
import { ephemeralCatalogEntry } from "./ephemeral-catalog.js";
import type { EphemeralMachine } from "./ephemeral-machine.js";
import type { BootstrapOpts, ExecFn, ExecRequest, ExecResult, ProviderAdapter, ProviderSize } from "./ephemeral-provider-ports.js";

export * from "./ephemeral-provider-ports.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- provisioning ----------------------------------------------------------

// AWS has no single API host — EC2 and SSM (used to resolve the current
// Ubuntu AMI) are per-region. Only the regions offered in the `aws` adapter's
// `regions` list below are allowlisted; add both hosts here when adding a
// region there.
export const ALLOWED_HOSTS = [
  "api.hetzner.cloud",
  "api.machines.dev",
  "api.fly.io",
  "api.sprites.dev",
  "api.e2b.app",
  "ec2.us-east-1.amazonaws.com",
  "ec2.us-west-2.amazonaws.com",
  "ec2.eu-west-1.amazonaws.com",
  "ec2.eu-central-1.amazonaws.com",
  "ec2.ap-southeast-1.amazonaws.com",
  "ec2.ap-northeast-1.amazonaws.com",
  "ssm.us-east-1.amazonaws.com",
  "ssm.us-west-2.amazonaws.com",
  "ssm.eu-west-1.amazonaws.com",
  "ssm.eu-central-1.amazonaws.com",
  "ssm.ap-southeast-1.amazonaws.com",
  "ssm.ap-northeast-1.amazonaws.com",
];

export function assertAllowedUrl(url: string): string {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new Error(`Bad provider URL: ${url}`);
  }
  if (!ALLOWED_HOSTS.includes(host)) throw new Error(`Refusing to send a token to non-provider host: ${host}`);
  return url;
}

async function call(exec: ExecFn, request: ExecRequest): Promise<ExecResult> {
  assertAllowedUrl(request.url);
  const res = await exec(request);
  return res || { status: 0, body: null };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${String(token || "").trim()}` };
}

function shq(s: unknown): string {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}
function indentJson(json: string, pad: string): string {
  return json.split("\n").map((l) => pad + l).join("\n");
}
function nowIso(): string {
  // Date is unavailable in some sandboxes; guard so pure imports don't throw.
  try {
    return new Date().toISOString();
  } catch {
    return "";
  }
}

/** The relay enrollment blob written to `/etc/bivy/relay.json`. The daemon reads
 *  it on boot (`startRelayIfConfigured` in src/server.ts) and dials the relay
 *  with no interactive `bivy setup` — the node was already enrolled by the
 *  launching device. */
function bivyRelayJson(opts: BootstrapOpts): string {
  return JSON.stringify({
    url: opts.relayUrl,
    enrollmentToken: opts.enrollmentToken,
    e2eKey: opts.e2eKeyB64,
    controlPlaneUrl: opts.controlPlaneUrl,
    clientBaseUrl: opts.controlPlaneUrl,
  });
}

/** The `export`s the daemon needs in its runtime env. `BIVY_DATA_DIR` points at
 *  the pre-baked `/etc/bivy` (relay.json + state); the rest are independently
 *  optional (repo, hosted-queue opt-in, routing label, GitHub token). Shared by
 *  the cloud-init (Hetzner/EC2) and Fly bootstraps so a node's env is identical
 *  however it was launched. */
function bivyBootstrapExports(opts: BootstrapOpts): string[] {
  // Destroy-lane providers learn they're disposable so the daemon can end the
  // machine itself once idle (src/ephemeral-teardown.ts). Suspend-to-zero
  // providers (Sprites/E2B) are KEPT, so they get no self-teardown env.
  const ephemeral = Boolean(opts.provider) && ephemeralCatalogEntry(opts.provider as string)?.suspendsWhenIdle !== true;
  return [
    "export BIVY_DATA_DIR=/etc/bivy",
    opts.repo ? `export BIVY_REPO=${shq(opts.repo)}` : "",
    opts.hostedTasks ? `export BIVY_GITHUB_HOSTED_TASKS=1` : "",
    opts.nodeLabel ? `export BIVY_NODE_LABEL=${shq(opts.nodeLabel)}` : "",
    opts.githubToken ? `export BIVY_GITHUB_TOKEN=${shq(opts.githubToken)}` : "",
    opts.hostedMint ? `export BIVY_HOSTED_MINT=1` : "",
    ephemeral ? `export BIVY_EPHEMERAL=1` : "",
    ephemeral ? `export BIVY_EPHEMERAL_PROVIDER=${shq(opts.provider)}` : "",
    ephemeral ? `export BIVY_EPHEMERAL_TTL_MIN=${clampTtlMinutes(opts.ttlMinutes)}` : "",
    ephemeral && opts.teardownOnAgentFinish ? `export BIVY_TEARDOWN_ON_FINISH=1` : "",
    ephemeral && opts.restoreSessionId ? `export BIVY_RESTORE=${shq(opts.restoreSessionId)}` : "",
  ].filter(Boolean);
}

/** `/etc/bivy/start.sh` — exports the runtime env then runs the daemon in the
 *  FOREGROUND (`exec bivy start`). This is the piece that was missing: the
 *  installer only *installs* Bivy, it never starts the node when there's no TTY
 *  (a headless, pre-enrolled machine). cloud-init runs this under `systemd-run`
 *  (a VM stays up on its own); Fly runs it as the machine's init process (a
 *  container needs a blocking foreground process or it exits and is destroyed).
 *  PATH is set explicitly because a non-login `systemd-run`/container shell
 *  doesn't source the rc file the installer appends BIN_DIR to. */
function bivyStartScript(opts: BootstrapOpts): string {
  const exports = bivyBootstrapExports(opts)
    .map((line) => `${line}\n`)
    .join("");
  return (
    "#!/bin/bash\n" +
    'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin:$PATH"\n' +
    exports +
    "exec bivy start\n"
  );
}

export function buildBootstrapUserData(opts: BootstrapOpts): string {
  const relay = bivyRelayJson(opts);
  const ttl = clampTtlMinutes(opts.ttlMinutes);
  const installUrl = opts.installUrl || "https://bivy.sh/install.sh";
  const startScript = bivyStartScript(opts);
  const status = (phase: string) =>
    `curl -fsS -X POST -H 'content-type: application/json' -H ${shq(`authorization: Bearer ${opts.enrollmentToken}`)} --data ${shq(JSON.stringify({ phase }))} ${shq(`${opts.controlPlaneUrl.replace(/\/$/, "")}/node/bootstrap-status`)} >/dev/null 2>&1 || true`;
  return (
    [
      "#cloud-config",
      "write_files:",
      "  - path: /etc/bivy/relay.json",
      "    permissions: '0600'",
      "    content: |",
      indentJson(relay, "      "),
      "  - path: /etc/bivy/start.sh",
      "    permissions: '0755'",
      "    content: |",
      indentJson(startScript, "      "),
      "runcmd:",
      `  - [ bash, -lc, ${JSON.stringify(status("booting"))} ]`,
      // 1. Install Bivy (state lands in /etc/bivy via BIVY_DATA_DIR).
      `  - [ bash, -lc, ${JSON.stringify(`${status("installing")}; mkdir -p /etc/bivy && export BIVY_DATA_DIR=/etc/bivy && (command -v bivy >/dev/null 2>&1 || curl -fsSL ${shq(installUrl)} | bash) || { ${status("failed")}; exit 1; }`)} ]`,
      // 2. Start the daemon. On a systemd VM a transient system unit keeps it
      `  - [ bash, -lc, ${JSON.stringify(status("starting"))} ]`,
      //    running after cloud-init's own unit exits (a bare backgrounded process
      //    would be cleaned up with cloud-final's cgroup); the setsid fallback
      //    covers a rare image without systemd-run.
      `  - [ bash, -lc, "systemd-run --unit=bivy --collect --property=Restart=on-failure /etc/bivy/start.sh || setsid bash /etc/bivy/start.sh </dev/null >/var/log/bivy.log 2>&1 &" ]`,
      // 3. TTL backstop: halt the VM so a forgotten machine can't bill forever.
      //    Prefer a systemd-run transient timer — it's owned by systemd, so it
      //    survives cloud-init exiting (unlike a bare backgrounded `sleep`, which
      //    cloud-final's cgroup reaps — the same reason step 2 uses systemd-run).
      //    Fall back to `at`, then to a detached setsid `sleep` for the rare image
      //    with neither, so the machine self-halts however minimal the base image.
      `  - [ bash, -lc, "systemd-run --on-active=${ttl}m --timer-property=AccuracySec=1s --unit=bivy-ttl shutdown -h now || (echo 'shutdown -h now' | at now + ${ttl} minutes) || setsid bash -c 'sleep ${ttl * 60}; shutdown -h now' </dev/null >/var/log/bivy-ttl.log 2>&1 &" ]`,
    ].join("\n") + "\n"
  );
}

/** Compatibility shell: the pure projection takes `nowMs` explicitly; callers
 *  using the historical API may omit it and read the clock at this effect edge. */
export function ephemeralCostEstimate(
  size: ProviderSize | undefined,
  createdAt: string,
  ttlMinutes?: number,
  nowMs = Date.now(),
): { accrued: number; maximum: number } | null {
  return deriveEphemeralCostEstimate(size, createdAt, ttlMinutes, nowMs);
}

export async function validateEphemeralProviderToken(
  provider: string,
  token: string,
  exec: ExecFn,
  region?: string,
): Promise<void> {
  const adapter = ephemeralAdapter(provider);
  if (!adapter) throw new Error(`Unknown provider: ${provider}`);
  const value = String(token || "").trim();
  if (!value) throw new Error(`${adapter.name} token is required`);
  if (!adapter.validateToken) throw new Error(`${adapter.name} credential validation is not available`);
  await adapter.validateToken({ exec, token: value, region: region || adapter.defaultRegion });
}

function mapHetznerStatus(s: string): string {
  return s === "running" ? "running" : s === "off" || s === "stopping" ? "stopped" : "starting";
}
function mapFlyStatus(s: string): string {
  return s === "started" ? "running" : s === "stopped" || s === "destroyed" ? "stopped" : "starting";
}

export function extractProviderMessage(body: any): string {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (typeof body.message === "string") return body.message;
  if (body.error && typeof body.error === "object") {
    const e = body.error;
    let m = typeof e.message === "string" ? e.message : typeof e.code === "string" ? e.code : "";
    const fields = e.details && Array.isArray(e.details.fields) ? e.details.fields : null;
    if (fields && fields.length) {
      const detail = fields
        .map((f: any) => `${f.name}: ${Array.isArray(f.messages) ? f.messages.join(", ") : f.messages || ""}`)
        .filter(Boolean)
        .join("; ");
      if (detail) m = m ? `${m} (${detail})` : detail;
    }
    return m;
  }
  if (typeof body.error === "string") return body.error;
  if (Array.isArray(body.errors) && body.errors.length) {
    return body.errors.map((e: any) => (typeof e === "string" ? e : e && e.message) || "").filter(Boolean).join("; ");
  }
  return "";
}

function providerError(res: ExecResult, action: string): string {
  const msg = extractProviderMessage(res && res.body);
  return `Provider failed to ${action} (HTTP ${res?.status}${msg ? `: ${msg}` : ""})`;
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

/**
 * Cache a promise by key for the lifetime of the JS context, deduping
 * concurrent callers. A rejected promise is evicted so a later call can retry.
 */
function memoizeByKey<T>(store: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit) return hit;
  const p = fn().catch((err) => {
    store.delete(key);
    throw err;
  });
  store.set(key, p);
  return p;
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

const hetzner: ProviderAdapter = {
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
        server_type: config.size || hetzner.defaultSize,
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

// Maps a Fly size id to the guest spec sent in the machine config.
const FLY_GUEST: Record<string, { cpus: number; memoryMb: number }> = {
  "shared-1x-1gb": { cpus: 1, memoryMb: 1024 },
  "shared-1x-2gb": { cpus: 1, memoryMb: 2048 },
  "shared-2x-4gb": { cpus: 2, memoryMb: 4096 },
  "shared-4x-8gb": { cpus: 4, memoryMb: 8192 },
};

/** Build the Fly Machine `config` fragment (`files` + `init.exec`) that boots a
 *  headless, pre-enrolled Bivy node. Fly can't run the shared cloud-init
 *  user_data (see the note in `fly.provision`), so the relay.json + start.sh are
 *  written as `files` and the daemon is launched as a blocking foreground init
 *  process. `raw_value` is base64 per the Machines API; `start.sh` is invoked via
 *  `bash <path>` so it needs no execute bit. */
function flyInit(opts: BootstrapOpts): {
  files: { guest_path: string; raw_value: string }[];
  init: { exec: string[] };
} {
  const installUrl = opts.installUrl || "https://bivy.sh/install.sh";
  const ttlSeconds = clampTtlMinutes(opts.ttlMinutes) * 60;
  const b64text = (s: string) => b64(utf8.encode(s));
  // Unlike the VM providers' cloud images, Fly's bare `ubuntu:24.04` OCI image
  // ships neither cloud-init NOR curl — so we install curl/ca-certificates
  // ourselves before fetching the installer (otherwise `curl | bash` fails with
  // "curl: command not found"). `set -euo pipefail` makes any step failing abort
  // the whole boot loudly instead of silently limping on to a doomed
  // `bivy start` — a failed boot then exits, and `auto_destroy` reaps the
  // machine so it's visible as gone rather than a silent zombie.
  const initScript = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "mkdir -p /etc/bivy",
    "export BIVY_DATA_DIR=/etc/bivy",
    `command -v bivy >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq curl ca-certificates; curl -fsSL ${shq(installUrl)} | bash; }`,
    // Hand the foreground to the daemon under a TTL `timeout` — the backstop
    // that replaces the VM's `shutdown -h now`. When it fires (or the agent
    // finishes) the process exits and `auto_destroy` removes the machine.
    `exec timeout ${ttlSeconds} bash /etc/bivy/start.sh`,
  ].join("\n");
  return {
    files: [
      { guest_path: "/etc/bivy/relay.json", raw_value: b64text(bivyRelayJson(opts)) },
      { guest_path: "/etc/bivy/start.sh", raw_value: b64text(bivyStartScript(opts)) },
    ],
    init: { exec: ["/bin/bash", "-lc", initScript] },
  };
}

const fly: ProviderAdapter = {
  id: "fly",
  name: "Fly.io",
  currency: "USD",
  regions: [
    { id: "iad", label: "Ashburn, VA" },
    { id: "sjc", label: "San Jose" },
    { id: "lhr", label: "London" },
    { id: "fra", label: "Frankfurt" },
    { id: "syd", label: "Sydney" },
    { id: "nrt", label: "Tokyo" },
  ],
  defaultRegion: "iad",
  // Indicative on-demand price/hour (USD) for the cost hint: Fly's shared-cpu
  // compute plus the extra RAM. Fly bills per second while the machine runs.
  sizes: [
    { id: "shared-1x-1gb", label: "shared · 1 vCPU · 1 GB", pricePerHour: 0.009 },
    { id: "shared-1x-2gb", label: "shared · 1 vCPU · 2 GB", pricePerHour: 0.0136 },
    { id: "shared-2x-4gb", label: "shared · 2 vCPU · 4 GB", pricePerHour: 0.0273 },
    { id: "shared-4x-8gb", label: "shared · 4 vCPU · 8 GB", pricePerHour: 0.0546 },
  ],
  defaultSize: "shared-1x-2gb",
  async validateToken({ exec, token }) {
    const res = await call(exec, {
      method: "GET",
      url: "https://api.machines.dev/v1/apps",
      headers: bearer(token),
    });
    if (res.status >= 300) throw new Error(providerError(res, "validate credential"));
  },
  async provision({ exec, token, config, userData, bootstrap }) {
    const app = `bivy-${config.slug}`;
    const org = config.org || "personal";
    const guest = FLY_GUEST[config.size as string] || FLY_GUEST[fly.defaultSize] || { cpus: 1, memoryMb: 2048 };
    const created = await call(exec, {
      method: "POST",
      url: "https://api.machines.dev/v1/apps",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: { app_name: app, org_slug: org },
    });
    if (created.status >= 300 && created.status !== 409) throw new Error(providerError(created, "create app"));
    // Fly app creation is naturally name-idempotent, but machine creation is
    // not. Adopt a machine carrying this attempt metadata before retrying create.
    if (config.attemptId) {
      const found = await call(exec, {
        method: "GET",
        url: `https://api.machines.dev/v1/apps/${encodeURIComponent(app)}/machines`,
        headers: bearer(token),
      });
      const existing = Array.isArray(found.body) ? found.body.find((m: any) => m?.config?.metadata?.["bivy-attempt"] === String(config.attemptId)) : null;
      if (found.status < 300 && existing?.id) {
        return { id: String(existing.id), provider: "fly", app, name: app, region: existing.region || config.region || "iad", status: mapFlyStatus(existing.state), ip: null, createdAt: nowIso(), ttlMinutes: config.ttlMinutes };
      }
    }
    // A Fly Machine is an OCI image in a Firecracker microVM, NOT a cloud-init
    // VM: the `#cloud-config` user_data the other providers use is never
    // executed, and a bare `ubuntu:24.04` just runs `/bin/bash`, which exits
    // immediately — so with `restart: no` + `auto_destroy` the machine boots and
    // self-destructs before it ever installs Bivy (that's the "app has no
    // machines" / node-offline symptom). Instead we materialize the same
    // relay.json + start.sh via `files` and run them ourselves as a blocking
    // foreground init process. `auto_destroy` tears the machine down when the
    // daemon exits. The daemon's quiet-state teardown snapshots completed work
    // and exits after `agent_end`, so this no longer depends on a watching
    // device; the TTL `timeout` remains an independent hard backstop. Falls back
    // to user_data only if no structured bootstrap is given.
    const machineInit = bootstrap ? flyInit(bootstrap) : { init: { user_data: userData } };
    const machine = await call(exec, {
      method: "POST",
      url: `https://api.machines.dev/v1/apps/${encodeURIComponent(app)}/machines`,
      headers: { ...bearer(token), "content-type": "application/json" },
      body: {
        region: config.region || "iad",
        config: {
          image: config.image || "ubuntu:24.04",
          // DEBUG: when keeping failed machines, don't auto-destroy — a boot
          // failure then stops the machine (logs retained) instead of vanishing.
          auto_destroy: bootstrap?.debugKeepMachine ? false : true,
          restart: { policy: "no" },
          guest: { cpu_kind: "shared", cpus: Number(config.cpus) || guest.cpus, memory_mb: Number(config.memoryMb) || guest.memoryMb },
          metadata: {
            bivy: "ephemeral",
            ...(config.attemptId ? { "bivy-attempt": String(config.attemptId) } : {}),
            ...(config.ownershipTag ? { "bivy-account": String(config.ownershipTag) } : {}),
          },
          ...machineInit,
        },
      },
    });
    if (machine.status >= 300) throw new Error(providerError(machine, "create machine"));
    const m = machine.body;
    if (!m || !m.id) throw new Error("Fly did not return a machine");
    return {
      id: String(m.id),
      provider: "fly",
      app,
      name: app,
      region: config.region || "iad",
      status: mapFlyStatus(m.state),
      ip: null,
      createdAt: nowIso(),
      ttlMinutes: config.ttlMinutes,
    };
  },
  async status({ exec, token, machine }) {
    const res = await call(exec, {
      method: "GET",
      url: `https://api.machines.dev/v1/apps/${encodeURIComponent(machine.app || "")}/machines/${encodeURIComponent(machine.id)}`,
      headers: bearer(token),
    });
    if (res.status === 404) return "gone";
    if (res.status >= 300) throw new Error(providerError(res, "get machine"));
    return mapFlyStatus(res.body?.state);
  },
  async destroy({ exec, token, machine }) {
    const res = await call(exec, {
      method: "DELETE",
      url: `https://api.machines.dev/v1/apps/${encodeURIComponent(machine.app || "")}/machines/${encodeURIComponent(machine.id)}?force=true`,
      headers: bearer(token),
    });
    if (res.status >= 300 && res.status !== 404) throw new Error(providerError(res, "delete machine"));
  },
  // Fly has no account-wide "list machines by tag" call — a Machine is scoped
  // to its app. Discovery instead lists every `bivy-`-prefixed app reachable
  // with this token and checks each one's machines for the ownership tag.
  // Bounded by how many bivy- apps exist for the token (normally very few);
  // one app's list call failing is skipped rather than aborting the scan.
  async discover({ exec, token, ownershipTag }) {
    const appsRes = await call(exec, { method: "GET", url: "https://api.machines.dev/v1/apps", headers: bearer(token) });
    if (appsRes.status >= 300) throw new Error(providerError(appsRes, "list apps"));
    const apps: any[] = Array.isArray(appsRes.body?.apps) ? appsRes.body.apps : Array.isArray(appsRes.body) ? appsRes.body : [];
    const found: EphemeralMachine[] = [];
    for (const a of apps) {
      const name = String(a?.name || "");
      if (!name.startsWith("bivy-")) continue;
      const res = await call(exec, { method: "GET", url: `https://api.machines.dev/v1/apps/${encodeURIComponent(name)}/machines`, headers: bearer(token) });
      if (res.status >= 300) continue;
      const machines: any[] = Array.isArray(res.body) ? res.body : [];
      for (const m of machines) {
        const meta = m?.config?.metadata || {};
        if (meta.bivy !== "ephemeral" || meta["bivy-account"] !== ownershipTag) continue;
        found.push({
          id: String(m.id),
          provider: "fly",
          app: name,
          name,
          region: m.region || "",
          status: mapFlyStatus(m.state),
          ip: null,
          createdAt: typeof m.created_at === "string" ? m.created_at : "",
          attemptId: typeof meta["bivy-attempt"] === "string" ? meta["bivy-attempt"] : undefined,
        });
      }
    }
    return found;
  },
};

// --- AWS: SigV4 signing + a minimal EC2 Query/XML client -------------------
//
// AWS has no bearer-token API: every request is authenticated by deriving an
// HMAC-SHA256 signature from the caller's access key + secret key (SigV4).
// Unlike Fly/Hetzner, that means the *adapter itself* signs each request
// before handing it to the allowlisted ExecFn — the exec proxy stays a dumb
// forwarder either way; it just now receives a fully pre-signed request, so
// no other call site needs to know AWS auth even exists. Implemented with
// only Web Crypto (crypto.subtle) so @bivy/core keeps zero runtime
// dependencies, and verified against AWS's own published SigV4 test vectors
// (see test/ephemeral-aws.test.ts).
//
// EC2 itself only speaks the legacy "Query" protocol — form-encoded request,
// XML response — there is no JSON protocol for EC2 (that exists for some
// newer AWS APIs, but not this one), so a tiny dependency-free XML reader is
// included below. Systems Manager (used only to resolve the current Ubuntu
// AMI id) speaks AWS's JSON protocol instead, which is why `awsSsmGetParameter`
// looks different from `awsEc2Call`.

export interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** AWS needs two secrets, not one (plus an optional session token for STS
 *  credentials) — pasted as `accessKeyId:secretAccessKey[:sessionToken]`.
 *  The token field itself stays an opaque string as far as the shared
 *  store/UI are concerned (see `EphemeralKeyStore`), so this parsing lives
 *  entirely inside the adapter and no call site needs to change to support a
 *  multi-part credential. */
export function parseAwsToken(token: string): AwsCreds {
  const parts = String(token || "").split(":");
  const accessKeyId = (parts[0] || "").trim();
  const secretAccessKey = (parts[1] || "").trim();
  const sessionToken = parts.length > 2 ? parts.slice(2).join(":").trim() || undefined : undefined;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS token must be `accessKeyId:secretAccessKey` (optionally `:sessionToken`)");
  }
  return { accessKeyId, secretAccessKey, sessionToken };
}

const utf8 = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? utf8.encode(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, utf8.encode(data)));
}

/** AWS's URI-encoding rule is RFC 3986 unreserved characters left bare and
 *  everything else percent-encoded with UPPERCASE hex. `encodeURIComponent`
 *  gets almost all of it right but leaves `! * ' ( )` unencoded, which SigV4
 *  requires encoded — AWS explicitly warns platform URI-encoders aren't safe
 *  to use as-is for this reason. */
function awsUriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function amzDateNow(): string {
  try {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  } catch {
    return "19700101T000000Z";
  }
}

/**
 * Sign one AWS request (SigV4) and return the headers to send, including
 * `authorization`. Canonical query string is always empty here — every AWS
 * call this adapter makes is a POST with the request in the body, so there's
 * nothing to canonicalize there. Verified against AWS's published
 * `get-vanilla`/`post-vanilla` SigV4 test vectors in test/ephemeral-aws.test.ts.
 */
export async function awsSign(args: {
  method: string;
  host: string;
  path: string;
  region: string;
  service: string;
  headers: Record<string, string>;
  body: string;
  creds: AwsCreds;
  amzDate?: string;
}): Promise<Record<string, string>> {
  const amzDate = args.amzDate || amzDateNow();
  const dateStamp = amzDate.slice(0, 8);
  const toSign: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.headers)) toSign[k.toLowerCase()] = v;
  toSign.host = args.host;
  toSign["x-amz-date"] = amzDate;
  if (args.creds.sessionToken) toSign["x-amz-security-token"] = args.creds.sessionToken;

  const signedHeaderNames = Object.keys(toSign).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${String(toSign[k]).trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const payloadHash = await sha256Hex(args.body);
  const canonicalRequest = [args.method.toUpperCase(), args.path || "/", "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${args.region}/${args.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256Hex(canonicalRequest)].join("\n");

  const kDate = await hmacSha256(utf8.encode(`AWS4${args.creds.secretAccessKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, args.region);
  const kService = await hmacSha256(kRegion, args.service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  return {
    ...toSign,
    authorization: `AWS4-HMAC-SHA256 Credential=${args.creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// --- tiny dependency-free XML reader (just enough for EC2 Query responses) -

export interface XmlEl {
  tag: string;
  children: XmlEl[];
  text: string;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

/** Recursive-descent parse of a well-formed XML document into a plain tree.
 *  Handles nested elements, attributes (discarded — EC2 responses don't put
 *  data we need in them), self-closing tags, comments, and the `<?xml?>`
 *  prolog. This is not a general-purpose XML parser — just enough for AWS's
 *  Query-protocol response shape, to avoid a real XML dependency for the one
 *  provider that needs it. */
export function parseXml(xml: string): XmlEl {
  let i = 0;
  const n = xml.length;
  const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
  function skipSpace() {
    while (i < n && isSpace(xml.charAt(i))) i++;
  }
  function skipMisc() {
    for (;;) {
      skipSpace();
      if (xml.startsWith("<?", i)) {
        const end = xml.indexOf("?>", i);
        i = end < 0 ? n : end + 2;
        continue;
      }
      if (xml.startsWith("<!--", i)) {
        const end = xml.indexOf("-->", i);
        i = end < 0 ? n : end + 3;
        continue;
      }
      if (xml.startsWith("<!", i)) {
        const end = xml.indexOf(">", i);
        i = end < 0 ? n : end + 1;
        continue;
      }
      break;
    }
  }
  function readName(): string {
    const start = i;
    while (i < n && !isSpace(xml.charAt(i)) && xml.charAt(i) !== ">" && xml.charAt(i) !== "/" && xml.charAt(i) !== "=") i++;
    return xml.slice(start, i);
  }
  function skipAttrs() {
    for (;;) {
      skipSpace();
      if (i >= n || xml.charAt(i) === ">" || xml.charAt(i) === "/") return;
      readName(); // attribute name — discarded
      skipSpace();
      if (xml.charAt(i) === "=") {
        i++;
        skipSpace();
        const quote = xml.charAt(i);
        if (quote === '"' || quote === "'") {
          i++;
          const end = xml.indexOf(quote, i);
          i = end < 0 ? n : end + 1;
        } else {
          while (i < n && !isSpace(xml.charAt(i)) && xml.charAt(i) !== ">") i++;
        }
      }
    }
  }
  function parseElement(): XmlEl {
    i++; // '<'
    const tag = readName();
    skipAttrs();
    skipSpace();
    const el: XmlEl = { tag, children: [], text: "" };
    if (xml.charAt(i) === "/") {
      i += 2; // '/>'
      return el;
    }
    i++; // '>'
    let text = "";
    while (i < n) {
      if (xml.startsWith("</", i)) {
        const end = xml.indexOf(">", i);
        i = end < 0 ? n : end + 1;
        break;
      }
      if (xml.startsWith("<!--", i)) {
        const end = xml.indexOf("-->", i);
        i = end < 0 ? n : end + 3;
        continue;
      }
      if (xml.charAt(i) === "<") {
        el.children.push(parseElement());
        continue;
      }
      const start = i;
      while (i < n && xml.charAt(i) !== "<") i++;
      text += xml.slice(start, i);
    }
    el.text = decodeXmlEntities(text).trim();
    return el;
  }
  skipMisc();
  if (i >= n || xml.charAt(i) !== "<") return { tag: "", children: [], text: "" };
  return parseElement();
}

export function xmlChild(el: XmlEl | undefined, tag: string): XmlEl | undefined {
  return el?.children.find((c) => c.tag === tag);
}
export function xmlChildren(el: XmlEl | undefined, tag: string): XmlEl[] {
  return el ? el.children.filter((c) => c.tag === tag) : [];
}
/** Depth-first search for the first descendant with this tag, anywhere in the
 *  subtree — used to pull error codes/messages and single-instance fields out
 *  of AWS's responses without depending on their exact nesting depth. */
export function xmlFind(el: XmlEl | undefined, tag: string): XmlEl | undefined {
  if (!el) return undefined;
  if (el.tag === tag) return el;
  for (const c of el.children) {
    const hit = xmlFind(c, tag);
    if (hit) return hit;
  }
  return undefined;
}

function awsFormBody(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`)
    .join("&");
}

function ec2Host(region: string): string {
  return `ec2.${region}.amazonaws.com`;
}
function ssmHost(region: string): string {
  return `ssm.${region}.amazonaws.com`;
}

/** One signed EC2 Query-protocol call. Returns the parsed XML root and throws
 *  with the provider's own error code/message on failure. */
async function awsEc2Call(
  exec: ExecFn,
  creds: AwsCreds,
  region: string,
  action: string,
  params: Record<string, string | undefined>,
  actionLabel: string,
): Promise<XmlEl> {
  const host = ec2Host(region);
  const body = awsFormBody({ Action: action, Version: "2016-11-15", ...params });
  const headers = await awsSign({
    method: "POST",
    host,
    path: "/",
    region,
    service: "ec2",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body,
    creds,
  });
  const res = await call(exec, { method: "POST", url: `https://${host}/`, headers, body });
  const xml = typeof res.body === "string" && res.body.trim() ? parseXml(res.body) : { tag: "", children: [], text: "" };
  if (res.status >= 300) {
    const code = xmlFind(xml, "Code")?.text;
    const message = xmlFind(xml, "Message")?.text;
    throw new Error(`AWS failed to ${actionLabel} (HTTP ${res.status}${code ? `: ${code}` : ""}${message ? ` — ${message}` : ""})`);
  }
  return xml;
}

/** One signed SSM (JSON protocol) call — only used to resolve the current
 *  Ubuntu AMI id via a Canonical-published public parameter. */
async function awsSsmGetParameter(exec: ExecFn, creds: AwsCreds, region: string, name: string): Promise<string> {
  const host = ssmHost(region);
  const body = JSON.stringify({ Name: name });
  const headers = await awsSign({
    method: "POST",
    host,
    path: "/",
    region,
    service: "ssm",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AmazonSSM.GetParameter" },
    body,
    creds,
  });
  const res = await call(exec, { method: "POST", url: `https://${host}/`, headers, body });
  if (res.status >= 300) {
    const msg = extractProviderMessage(res.body) || (res.body && typeof res.body === "object" ? String((res.body as any).__type ?? "") : "");
    throw new Error(`AWS failed to resolve the Ubuntu AMI (HTTP ${res.status}${msg ? `: ${msg}` : ""})`);
  }
  const value = res.body && typeof res.body === "object" ? (res.body as any)?.Parameter?.Value : undefined;
  if (!value) throw new Error("AWS SSM did not return an AMI id");
  return String(value);
}

// Canonical publishes the current Ubuntu 24.04 (Noble) amd64 AMI id per
// region as a public SSM parameter, so we always launch the latest image
// instead of a hardcoded id that eventually goes stale. Memoized per region
// (the value doesn't depend on which account looks it up) for the lifetime of
// the JS context, same pattern as Hetzner's server-type cache below.
const AWS_UBUNTU_AMI_PARAM = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id";
const awsAmiCache = new Map<string, Promise<string>>();
function resolveUbuntuAmi(exec: ExecFn, creds: AwsCreds, region: string): Promise<string> {
  return memoizeByKey(awsAmiCache, region, () => awsSsmGetParameter(exec, creds, region, AWS_UBUNTU_AMI_PARAM));
}

function mapAwsStatus(name: string | undefined): string {
  switch (name) {
    case "running":
      return "running";
    case "pending":
      return "starting";
    case "stopping":
    case "stopped":
    case "shutting-down":
      return "stopped";
    case "terminated":
      return "gone";
    default:
      return "starting";
  }
}

const AWS_REGIONS = [
  { id: "us-east-1", label: "US East (N. Virginia)" },
  { id: "us-west-2", label: "US West (Oregon)" },
  { id: "eu-west-1", label: "Europe (Ireland)" },
  { id: "eu-central-1", label: "Europe (Frankfurt)" },
  { id: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
  { id: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
];

// A curated, x86_64 (amd64) subset of EC2's general-purpose "T" burstable
// family — matches the Ubuntu amd64 AMI resolved via SSM above. `listSizes`
// narrows this to whatever DescribeInstanceTypes confirms is actually
// orderable in the chosen region, same live-catalog pattern as Hetzner.
// Indicative on-demand price/hour (USD, us-east-1) for the cost hint. Real
// price varies by region; this is close enough for an at-a-glance estimate.
const AWS_SIZES: ProviderSize[] = [
  { id: "t3.micro", label: "t3.micro · 2 vCPU · 1 GB", pricePerHour: 0.0104 },
  { id: "t3.small", label: "t3.small · 2 vCPU · 2 GB", pricePerHour: 0.0208 },
  { id: "t3.medium", label: "t3.medium · 2 vCPU · 4 GB", pricePerHour: 0.0416 },
  { id: "t3.large", label: "t3.large · 2 vCPU · 8 GB", pricePerHour: 0.0832 },
  { id: "t3.xlarge", label: "t3.xlarge · 4 vCPU · 16 GB", pricePerHour: 0.1664 },
  { id: "t3.2xlarge", label: "t3.2xlarge · 8 vCPU · 32 GB", pricePerHour: 0.3328 },
];

const aws: ProviderAdapter = {
  id: "aws",
  name: "AWS EC2",
  currency: "USD",
  regions: AWS_REGIONS,
  defaultRegion: "us-east-1",
  sizes: AWS_SIZES,
  defaultSize: "t3.medium",
  async validateToken({ exec, token, region }) {
    const creds = parseAwsToken(token);
    await awsEc2Call(exec, creds, region || aws.defaultRegion, "DescribeInstances", { MaxResults: "5" }, "validate credential");
  },
  async listSizes({ exec, token, region }) {
    const creds = parseAwsToken(token);
    const reg = region || aws.defaultRegion;
    const params: Record<string, string> = {};
    AWS_SIZES.forEach((s, idx) => {
      params[`InstanceType.${idx + 1}`] = s.id;
    });
    let xml: XmlEl;
    try {
      xml = await awsEc2Call(exec, creds, reg, "DescribeInstanceTypes", params, "list instance types");
    } catch {
      return AWS_SIZES; // best-effort — keep the static list rather than failing the picker
    }
    const rows = xmlChildren(xmlChild(xml, "instanceTypeSet"), "item")
      .map((item): ProviderSize | null => {
        const id = xmlChild(item, "instanceType")?.text || "";
        const vcpus = xmlChild(xmlChild(item, "vCpuInfo"), "defaultVCpus")?.text;
        const memMib = xmlChild(xmlChild(item, "memoryInfo"), "sizeInMiB")?.text;
        const gb = memMib ? Math.round(Number(memMib) / 1024) : undefined;
        // EC2's DescribeInstanceTypes carries no pricing, so carry the static
        // indicative price across by instance-type id for the cost hint.
        const pricePerHour = AWS_SIZES.find((s) => s.id === id)?.pricePerHour;
        return id ? { id, label: `${id} · ${vcpus ?? "?"} vCPU · ${gb ?? "?"} GB`, pricePerHour } : null;
      })
      .filter((r): r is ProviderSize => Boolean(r));
    return rows.length ? rows : AWS_SIZES;
  },
  async provision({ exec, token, config, userData }) {
    const creds = parseAwsToken(token);
    const region = config.region || aws.defaultRegion;
    const name = `bivy-${config.slug}`;
    const amiId = config.image ? String(config.image) : await resolveUbuntuAmi(exec, creds, region);
    const xml = await awsEc2Call(
      exec,
      creds,
      region,
      "RunInstances",
      {
        ImageId: amiId,
        InstanceType: config.size || aws.defaultSize,
        MinCount: "1",
        MaxCount: "1",
        UserData: b64(utf8.encode(userData)),
        InstanceInitiatedShutdownBehavior: "terminate",
        // EC2 makes RunInstances idempotent for this token. A retry after a
        // timeout returns the original instance rather than billing for another.
        ...(config.attemptId ? { ClientToken: String(config.attemptId) } : {}),
        "TagSpecification.1.ResourceType": "instance",
        "TagSpecification.1.Tag.1.Key": "Name",
        "TagSpecification.1.Tag.1.Value": name,
        "TagSpecification.1.Tag.2.Key": "bivy",
        "TagSpecification.1.Tag.2.Value": "ephemeral",
        ...(config.attemptId ? {
          "TagSpecification.1.Tag.3.Key": "bivy-attempt",
          "TagSpecification.1.Tag.3.Value": String(config.attemptId),
        } : {}),
        ...(config.ownershipTag ? {
          "TagSpecification.1.Tag.4.Key": "bivy-account",
          "TagSpecification.1.Tag.4.Value": String(config.ownershipTag),
        } : {}),
      },
      "launch instance",
    );
    const item = xmlChild(xmlChild(xml, "instancesSet"), "item");
    const instanceId = xmlChild(item, "instanceId")?.text;
    if (!instanceId) throw new Error("AWS did not return an instance id");
    const stateName = xmlChild(xmlChild(item, "instanceState"), "name")?.text;
    // A public IP is usually assigned immediately when launching into a
    // default VPC/subnet, but isn't guaranteed at RunInstances time — status()
    // picks it up on the next poll if it's missing here, same as Fly.
    const ip = xmlChild(item, "ipAddress")?.text || xmlFind(xmlChild(item, "networkInterfaceSet"), "publicIp")?.text || null;
    return {
      id: instanceId,
      provider: "aws",
      name,
      region,
      status: mapAwsStatus(stateName),
      ip: ip || null,
      createdAt: nowIso(),
      ttlMinutes: config.ttlMinutes,
    };
  },
  async status({ exec, token, machine }) {
    const creds = parseAwsToken(token);
    let xml: XmlEl;
    try {
      xml = await awsEc2Call(exec, creds, machine.region, "DescribeInstances", { "InstanceId.1": machine.id }, "get instance");
    } catch (err) {
      if (String((err as Error).message || "").includes("InvalidInstanceID.NotFound")) return "gone";
      throw err;
    }
    const item = xmlChild(xmlFind(xml, "instancesSet"), "item");
    if (!item) return "gone";
    return mapAwsStatus(xmlChild(xmlChild(item, "instanceState"), "name")?.text);
  },
  async destroy({ exec, token, machine }) {
    const creds = parseAwsToken(token);
    try {
      await awsEc2Call(exec, creds, machine.region, "TerminateInstances", { "InstanceId.1": machine.id }, "terminate instance");
    } catch (err) {
      if (!String((err as Error).message || "").includes("InvalidInstanceID.NotFound")) throw err;
    }
  },
  // EC2 has no cross-region "list by tag" call — a DescribeInstances Filter is
  // always scoped to the region it's sent to. Scanning the whole curated
  // region list keeps this correct even if an account's config region ever
  // changed; it's bounded (six regions) and this only runs on the slow,
  // infrequent orphan-sweep cadence, not the fast convergence loop. One
  // region failing (e.g. not opted into that region) is skipped, not fatal.
  async discover({ exec, token, ownershipTag }) {
    const creds = parseAwsToken(token);
    const found: EphemeralMachine[] = [];
    for (const region of AWS_REGIONS.map((r) => r.id)) {
      let xml: XmlEl;
      try {
        xml = await awsEc2Call(
          exec,
          creds,
          region,
          "DescribeInstances",
          {
            "Filter.1.Name": "tag:bivy-account",
            "Filter.1.Value.1": ownershipTag,
            "Filter.2.Name": "instance-state-name",
            "Filter.2.Value.1": "pending",
            "Filter.2.Value.2": "running",
            "Filter.2.Value.3": "stopping",
            "Filter.2.Value.4": "stopped",
          },
          "list instances",
        );
      } catch {
        continue;
      }
      for (const reservation of xmlChildren(xmlChild(xml, "reservationSet"), "item")) {
        for (const item of xmlChildren(xmlChild(reservation, "instancesSet"), "item")) {
          const instanceId = xmlChild(item, "instanceId")?.text;
          if (!instanceId) continue;
          const stateName = xmlChild(xmlChild(item, "instanceState"), "name")?.text;
          const attemptTag = xmlChildren(xmlChild(item, "tagSet"), "item").find((t) => xmlChild(t, "key")?.text === "bivy-attempt");
          found.push({
            id: instanceId,
            provider: "aws",
            name: instanceId,
            region,
            status: mapAwsStatus(stateName),
            ip: xmlChild(item, "ipAddress")?.text || null,
            createdAt: xmlChild(item, "launchTime")?.text || "",
            attemptId: attemptTag ? xmlChild(attemptTag, "value")?.text : undefined,
          });
        }
      }
    }
    return found;
  },
};

// --- Fly Sprites: stateful sandboxes that suspend to ~zero when idle ---------
//
// Sprites (https://sprites.dev) are the "machines that remember" model: a
// bearer-token REST API (like Fly/Hetzner) that creates a Linux box which
// auto-SUSPENDS when idle — costing ~nothing — and RESUMES with its full
// filesystem and memory intact. That's a different lifecycle from the other
// providers: instead of destroy-when-done plus a TTL self-shutdown, a Sprite is
// KEPT and simply woken again when the user reopens its session (see `wake`
// below and the controller's resume-on-open wiring). There's no cloud-init;
// Sprites are bootstrapped by registering the daemon as a supervised *service*
// over the same REST API, which also gives a clean, single-request wake path
// (start the service) that our HTTPS exec proxy can drive with no WebSocket.
const SPRITES_HOST = "https://api.sprites.dev";
const SPRITES_SERVICE = "bivy";

const SPRITES_REGIONS = [
  { id: "iad", label: "Ashburn, VA" },
  { id: "sjc", label: "San Jose" },
  { id: "ord", label: "Chicago" },
  { id: "lhr", label: "London" },
  { id: "fra", label: "Frankfurt" },
  { id: "syd", label: "Sydney" },
  { id: "nrt", label: "Tokyo" },
];

// A Sprites size is a (cpus, ram) pair rather than a named plan. Prices are
// indicative USD/hr while ACTIVE; a suspended Sprite costs ~$0 (the UI notes
// this via `suspendsWhenIdle`).
const SPRITES_GUEST: Record<string, { cpus: number; ramMb: number }> = {
  "2x4": { cpus: 2, ramMb: 4096 },
  "4x8": { cpus: 4, ramMb: 8192 },
  "8x8": { cpus: 8, ramMb: 8192 },
  "8x16": { cpus: 8, ramMb: 16384 },
};
const SPRITES_SIZES: ProviderSize[] = [
  { id: "2x4", label: "2 vCPU · 4 GB", pricePerHour: 0.06 },
  { id: "4x8", label: "4 vCPU · 8 GB", pricePerHour: 0.115 },
  { id: "8x8", label: "8 vCPU · 8 GB", pricePerHour: 0.16 },
  { id: "8x16", label: "8 vCPU · 16 GB", pricePerHour: 0.22 },
];

function mapSpritesStatus(s: string): string {
  const v = String(s || "").toLowerCase();
  if (/(destroy|delet|gone)/.test(v)) return "gone";
  if (/(cold|susp|sleep|stop|off|hibernat)/.test(v)) return "stopped";
  if (/(run|warm|ready)/.test(v)) return "running";
  return "starting"; // creating / new / pending / starting / unknown
}

/** The boot script the `bivy` Sprites service supervises. Writes the relay
 *  enrollment from an env var (no separate file-API call), installs Bivy once
 *  (persisted across suspends by the Sprite's own storage), then runs the daemon
 *  in the foreground so the service supervisor keeps it alive and re-dials the
 *  relay after each resume. */
function bivySpritesServiceScript(installUrl: string): string {
  return [
    "set -e",
    "mkdir -p /etc/bivy",
    'printf %s "$BIVY_RELAY_JSON_B64" | base64 -d > /etc/bivy/relay.json',
    "chmod 600 /etc/bivy/relay.json",
    'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin:$PATH"',
    `command -v bivy >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq curl ca-certificates; curl -fsSL ${shq(installUrl)} | bash; }`,
    "exec bivy start",
  ].join("\n");
}

/** The env a managed-sandbox daemon runs with — relay enrollment (base64) plus
 *  the same optional BIVY_* switches the other providers export. Shared by the
 *  Fly Sprites service and the E2B template bootstrap. */
function bivyNodeEnv(opts: BootstrapOpts): Record<string, string> {
  const env: Record<string, string> = {
    BIVY_DATA_DIR: "/etc/bivy",
    BIVY_RELAY_JSON_B64: b64(utf8.encode(bivyRelayJson(opts))),
  };
  if (opts.repo) env.BIVY_REPO = opts.repo;
  if (opts.hostedTasks) env.BIVY_GITHUB_HOSTED_TASKS = "1";
  if (opts.nodeLabel) env.BIVY_NODE_LABEL = opts.nodeLabel;
  if (opts.githubToken) env.BIVY_GITHUB_TOKEN = opts.githubToken;
  if (opts.hostedMint) env.BIVY_HOSTED_MINT = "1";
  return env;
}

const sprites: ProviderAdapter = {
  id: "sprites",
  name: "Fly Sprites",
  currency: "USD",
  suspendsWhenIdle: ephemeralCatalogEntry("sprites")?.suspendsWhenIdle,
  regions: SPRITES_REGIONS,
  defaultRegion: "iad",
  sizes: SPRITES_SIZES,
  defaultSize: "4x8",
  async validateToken({ exec, token }) {
    const res = await call(exec, { method: "GET", url: `${SPRITES_HOST}/v1/sprites`, headers: bearer(token) });
    if (res.status >= 300) throw new Error(providerError(res, "validate credential"));
  },
  async provision({ exec, token, config, bootstrap }) {
    const name = `bivy-${config.slug}`;
    const guest = SPRITES_GUEST[config.size as string] || SPRITES_GUEST[sprites.defaultSize] || { cpus: 4, ramMb: 8192 };
    // 1. Create the sprite.
    const created = await call(exec, {
      method: "POST",
      url: `${SPRITES_HOST}/v1/sprites`,
      headers: { ...bearer(token), "content-type": "application/json" },
      body: {
        name,
        config: { cpus: guest.cpus, ram_mb: guest.ramMb, region: config.region || sprites.defaultRegion },
        labels: ["bivy"],
      },
    });
    if (created.status >= 300 && created.status !== 409) throw new Error(providerError(created, "create sprite"));
    if (!bootstrap) throw new Error("Sprites bootstrap missing");
    const installUrl = bootstrap.installUrl || "https://bivy.sh/install.sh";
    // 2. Register the daemon as a supervised service (PUT = create-or-replace).
    const svc = await call(exec, {
      method: "PUT",
      url: `${SPRITES_HOST}/v1/sprites/${encodeURIComponent(name)}/services/${SPRITES_SERVICE}`,
      headers: { ...bearer(token), "content-type": "application/json" },
      body: { cmd: "bash", args: ["-lc", bivySpritesServiceScript(installUrl)], env: bivyNodeEnv(bootstrap) },
    });
    if (svc.status >= 300) throw new Error(providerError(svc, "register bivy service"));
    // 3. Start the service — boots the daemon now, and is the same call `wake`
    //    uses later to resume a suspended Sprite.
    const started = await call(exec, {
      method: "POST",
      url: `${SPRITES_HOST}/v1/sprites/${encodeURIComponent(name)}/services/${SPRITES_SERVICE}/start`,
      headers: bearer(token),
    });
    if (started.status >= 300) throw new Error(providerError(started, "start bivy service"));
    return {
      id: name,
      provider: "sprites",
      app: name,
      name,
      region: config.region || sprites.defaultRegion,
      status: "starting",
      ip: null,
      createdAt: nowIso(),
    };
  },
  async status({ exec, token, machine }) {
    const res = await call(exec, {
      method: "GET",
      url: `${SPRITES_HOST}/v1/sprites/${encodeURIComponent(machine.app || machine.id)}`,
      headers: bearer(token),
    });
    if (res.status === 404) return "gone";
    if (res.status >= 300) throw new Error(providerError(res, "get sprite"));
    return mapSpritesStatus(res.body?.status);
  },
  async destroy({ exec, token, machine }) {
    const res = await call(exec, {
      method: "DELETE",
      url: `${SPRITES_HOST}/v1/sprites/${encodeURIComponent(machine.app || machine.id)}`,
      headers: bearer(token),
    });
    if (res.status >= 300 && res.status !== 404) throw new Error(providerError(res, "delete sprite"));
  },
  async wake({ exec, token, machine }) {
    // Starting the supervised service both wakes the suspended Sprite (any
    // request routed to it resumes it at the edge) and ensures the daemon is
    // running so it re-dials the relay. Idempotent on an already-running Sprite.
    const res = await call(exec, {
      method: "POST",
      url: `${SPRITES_HOST}/v1/sprites/${encodeURIComponent(machine.app || machine.id)}/services/${SPRITES_SERVICE}/start`,
      headers: bearer(token),
    });
    if (res.status >= 300 && res.status !== 404) throw new Error(providerError(res, "wake sprite"));
  },
};

// --- E2B: managed agent sandboxes with a deterministic idle timeout ----------
//
// E2B (https://e2b.dev) is the other "managed sandbox" substrate alongside Fly
// Sprites: a REST API (host api.e2b.app, `X-API-Key` auth) that creates a
// Firecracker microVM for agent workloads. Its lifecycle is enforced
// SERVER-SIDE by E2B, not by a Bivy device or node: every sandbox carries a
// `timeout`, and when it elapses E2B either KILLS the sandbox or — with
// `autoPause` — PAUSES it to ~$0 with full filesystem + memory state, resumable
// later (~1s) with everything intact.
//
// We model E2B as a suspend-when-idle provider (like Sprites): the sandbox is
// KEPT and woken via `wake` (resume) when the user reopens its session, rather
// than destroy-when-done + TTL self-shutdown. Unlike Sprites, E2B's pause is
// DETERMINISTIC — driven by the server-enforced timeout, not by an external
// idle heuristic — so it doesn't depend on the daemon's relay socket looking
// "idle" (see docs/ephemeral-sessions.md on the Sprites idle-suspend caveat).
//
// PROTOTYPE — written against E2B's documented REST shape and unit-tested with
// an injected transport, but NOT yet confirmed against a live key, and it
// depends on an external artifact. Before GA (tracked in
// docs/ephemeral-sessions.md#e2b):
//   1. Bootstrap needs published `bivy-<size>` E2B templates that install Bivy
//      and run `bivy start`, reading relay enrollment from the env vars we pass
//      at create — E2B runs a template's start command and (unlike Sprites)
//      can't take an arbitrary boot script at create time.
//   2. Endpoint paths / field names (`/v2/sandboxes`, `autoPause`, `envVars`,
//      `sandboxID`, `/resume`) need live confirmation.
//   3. The timeout is wall-clock, not activity-based: to keep a long ACTIVE
//      session warm someone must refresh it (device-online vs. a control-plane
//      keepalive) — the same lifecycle question the BYO lane tracks. For now we
//      set a generous fixed window and let autoPause preserve state if it
//      elapses mid-session.
const E2B_HOST = "https://api.e2b.app";
const E2B_TEMPLATE_PREFIX = "bivy-"; // published templates: bivy-1x2, bivy-2x4, ...
// Window (seconds) before E2B auto-pauses the sandbox to ~$0.
const E2B_TIMEOUT_S = 3600;

function e2bAuth(token: string): Record<string, string> {
  return { "X-API-Key": String(token || "").trim() };
}

// E2B sandbox resources come from the template, so each size maps to a distinct
// published template (E2B_TEMPLATE_PREFIX + size id). Prices are indicative
// USD/hr while ACTIVE, derived from E2B's per-second vCPU + RAM rates; a paused
// sandbox costs ~$0 (snapshot storage aside), surfaced via `suspendsWhenIdle`.
const E2B_SIZES: ProviderSize[] = [
  { id: "1x2", label: "1 vCPU · 2 GB", pricePerHour: 0.08 },
  { id: "2x4", label: "2 vCPU · 4 GB", pricePerHour: 0.17 },
  { id: "4x8", label: "4 vCPU · 8 GB", pricePerHour: 0.33 },
  { id: "8x16", label: "8 vCPU · 16 GB", pricePerHour: 0.66 },
];

function mapE2bStatus(s: string): string {
  const v = String(s || "").toLowerCase();
  if (/(kill|delet|destroy|gone)/.test(v)) return "gone";
  if (/(paus|susp|stop|sleep)/.test(v)) return "stopped";
  if (/(run|ready)/.test(v)) return "running";
  return "starting"; // creating / pending / resuming / unknown
}

const e2b: ProviderAdapter = {
  id: "e2b",
  name: "E2B",
  currency: "USD",
  suspendsWhenIdle: ephemeralCatalogEntry("e2b")?.suspendsWhenIdle,
  regions: [{ id: "us", label: "United States" }],
  defaultRegion: "us",
  sizes: E2B_SIZES,
  defaultSize: "2x4",
  async validateToken({ exec, token }) {
    const res = await call(exec, { method: "GET", url: `${E2B_HOST}/v2/sandboxes?limit=1`, headers: e2bAuth(token) });
    if (res.status >= 300) throw new Error(providerError(res, "validate credential"));
  },
  async provision({ exec, token, config, bootstrap }) {
    if (!bootstrap) throw new Error("E2B bootstrap missing");
    const size = (config.size as string) || e2b.defaultSize;
    // Relay enrollment + optional switches ride as env vars the published
    // `bivy-<size>` template's start command reads to run `bivy start`.
    const created = await call(exec, {
      method: "POST",
      url: `${E2B_HOST}/v2/sandboxes`,
      headers: { ...e2bAuth(token), "content-type": "application/json" },
      body: {
        templateID: `${E2B_TEMPLATE_PREFIX}${size}`,
        timeout: E2B_TIMEOUT_S,
        autoPause: true,
        metadata: { bivy: "1", slug: String(config.slug || "") },
        envVars: bivyNodeEnv(bootstrap),
      },
    });
    if (created.status >= 300 && created.status !== 409) throw new Error(providerError(created, "create sandbox"));
    const id = String(created.body?.sandboxID || created.body?.sandboxId || created.body?.id || "");
    if (!id) throw new Error("E2B create returned no sandbox id");
    return {
      id,
      provider: "e2b",
      app: id,
      name: `bivy-${config.slug}`,
      region: e2b.defaultRegion,
      status: "starting",
      ip: null,
      createdAt: nowIso(),
    };
  },
  async status({ exec, token, machine }) {
    const res = await call(exec, {
      method: "GET",
      url: `${E2B_HOST}/v2/sandboxes/${encodeURIComponent(machine.app || machine.id)}`,
      headers: e2bAuth(token),
    });
    if (res.status === 404) return "gone";
    if (res.status >= 300) throw new Error(providerError(res, "get sandbox"));
    return mapE2bStatus(res.body?.state || res.body?.status);
  },
  async destroy({ exec, token, machine }) {
    const res = await call(exec, {
      method: "DELETE",
      url: `${E2B_HOST}/v2/sandboxes/${encodeURIComponent(machine.app || machine.id)}`,
      headers: e2bAuth(token),
    });
    if (res.status >= 300 && res.status !== 404) throw new Error(providerError(res, "kill sandbox"));
  },
  async wake({ exec, token, machine }) {
    // Resume a paused sandbox so it rejoins the relay. A resume on an already
    // running sandbox may 409/400, which we treat as already-awake.
    const res = await call(exec, {
      method: "POST",
      url: `${E2B_HOST}/v2/sandboxes/${encodeURIComponent(machine.app || machine.id)}/resume`,
      headers: { ...e2bAuth(token), "content-type": "application/json" },
      body: { timeout: E2B_TIMEOUT_S, autoPause: true },
    });
    if (res.status >= 300 && res.status !== 404 && res.status !== 409) throw new Error(providerError(res, "resume sandbox"));
  },
};

const ADAPTERS: Record<string, ProviderAdapter> = { hetzner, fly, aws, sprites, e2b };
export function ephemeralAdapter(id: string): ProviderAdapter | null {
  return ADAPTERS[String(id || "").trim().toLowerCase()] || null;
}
