// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Fly Machines provider interpreter.
import { b64 } from "../base64.js";
import { bivyRelayJson, bivyStartScript } from "../ephemeral-provider-bootstrap.js";
import { clampTtlMinutes } from "../ephemeral-lifecycle.js";
import type { EphemeralMachine } from "../ephemeral-machine.js";
import type { BootstrapOpts, ProviderAdapter } from "../ephemeral-provider-ports.js";
import { bearer, call, nowIso, providerError, shq, utf8 } from "../ephemeral-provider-utils.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

function mapFlyStatus(s: string): string {
  return s === "started" ? "running" : s === "stopped" || s === "destroyed" ? "stopped" : "starting";
}

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

export const flyProvider: ProviderAdapter = {
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
    const guest = FLY_GUEST[config.size as string] || FLY_GUEST[flyProvider.defaultSize] || { cpus: 1, memoryMb: 2048 };
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
