// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Fly Machines provider interpreter.
import { b64 } from "../base64.js";
import { bivyBootstrapStatusCommand, bivyRelayJson, bivyStartScript } from "../ephemeral-provider-bootstrap.js";
import { clampTtlMinutes } from "../ephemeral-lifecycle.js";
import type { EphemeralMachine } from "../ephemeral-machine.js";
import type { BootstrapOpts, ExecFn, ProviderAdapter } from "../ephemeral-provider-ports.js";
import { bearer, call, extractProviderMessage, nowIso, providerError, shq, utf8 } from "../ephemeral-provider-utils.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Public, credential-free, amd64 runner. Pin the tested artifact rather than a
// mutable tag; custom images remain an explicit compatibility escape hatch.
export const FLY_RUNNER_IMAGE = "ghcr.io/bivysh/bivy-ephemeral-runner@sha256:30705bdda88425646b0c5dc19fc0e95cc4a026ca9c09a4f904c15b3a21e246ac";

function mapFlyStatus(s: string): string {
  return s === "started" ? "running" : s === "destroyed" ? "gone" : s === "stopped" ? "stopped" : "starting";
}

// Fly's Machines API scopes `/v1/apps` to an org: the endpoint is
// `GET /v1/apps?org_slug=<org>`, and called bare (no org_slug) it 404s with a
// plain "404 page not found" body — which surfaced as a bogus onboarding
// "Provider failed to validate credential" error.
//
// We can't assume the org is `personal`: a Fly account created via GitHub gets a
// *named* org (not slugged "personal"), and that org is the only place the
// dashboard lets you mint API tokens — so a real user's token is scoped to it,
// and `org_slug=personal` would 404 just like the bare URL. Since a token is
// scoped to the org(s) it can reach, we ask Fly which org this token can see and
// use that. The Machines API has no "list orgs" call, so this uses the GraphQL
// API (read-only query) — the same host flyctl uses, already host-allowlisted.
const FLY_DEFAULT_ORG = "personal";

// Resolve the org slug a token should provision into. Prefers an explicit
// override, then a personal-type org when the token can see one, else the first
// org it can reach. Throws when the token is invalid or sees no org, so it
// doubles as the credential check. GraphQL auth failures come back as non-2xx;
// a valid token with an empty/errored result yields no nodes.
async function resolveFlyOrg(exec: ExecFn, token: string, preferred?: string): Promise<string> {
  const override = String(preferred || "").trim();
  if (override) return override;
  const res = await call(exec, {
    method: "POST",
    url: "https://api.fly.io/graphql",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: { query: "query { organizations { nodes { slug type } } }" },
  });
  if (res.status >= 300) throw new Error(providerError(res, "list organizations"));
  const nodes: any[] = Array.isArray(res.body?.data?.organizations?.nodes) ? res.body.data.organizations.nodes : [];
  if (!nodes.length) {
    const detail = extractProviderMessage(res.body);
    throw new Error(`Fly token has no accessible organizations${detail ? `: ${detail}` : ""}`);
  }
  const personal = nodes.find((o) => String(o?.type || "").toUpperCase() === "PERSONAL" && o?.slug);
  const chosen = personal || nodes.find((o) => o?.slug) || nodes[0];
  return String(chosen?.slug || FLY_DEFAULT_ORG);
}

// Maps a Fly size id to the guest spec sent in the machine config. `cpuKind`
// lives on the row (not hardcoded at the create call) so a performance lane is
// a new data row, not new code.
const FLY_GUEST: Record<string, { cpus: number; memoryMb: number; cpuKind: string }> = {
  "shared-1x-1gb": { cpus: 1, memoryMb: 1024, cpuKind: "shared" },
  "shared-1x-2gb": { cpus: 1, memoryMb: 2048, cpuKind: "shared" },
  "shared-2x-4gb": { cpus: 2, memoryMb: 4096, cpuKind: "shared" },
  "shared-4x-8gb": { cpus: 4, memoryMb: 8192, cpuKind: "shared" },
  "shared-8x-16gb": { cpus: 8, memoryMb: 16384, cpuKind: "shared" },
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
    'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin:$PATH"',
    "export DEBIAN_FRONTEND=noninteractive",
    "mkdir -p /etc/bivy /workspace",
    "chmod 700 /etc/bivy",
    "chmod 600 /etc/bivy/relay.json /etc/bivy/start.sh",
    "export BIVY_DATA_DIR=/etc/bivy",
    "export BIVY_WORKSPACE=/workspace",
    `trap ${shq(bivyBootstrapStatusCommand(opts, "failed"))} ERR`,
    bivyBootstrapStatusCommand(opts, "booting"),
    `if ! command -v bivy >/dev/null 2>&1; then\n${bivyBootstrapStatusCommand(opts, "installing")}\napt-get update -qq\napt-get install -y -qq curl ca-certificates\ncurl --connect-timeout 10 --max-time 120 -fsSL ${shq(installUrl)} | bash\nfi`,
    bivyBootstrapStatusCommand(opts, "starting"),
    "exec bash /etc/bivy/start.sh",
  ].join("\n");
  return {
    files: [
      { guest_path: "/etc/bivy/relay.json", raw_value: b64text(bivyRelayJson(opts)) },
      { guest_path: "/etc/bivy/start.sh", raw_value: b64text(bivyStartScript(opts)) },
    ],
    // Bound the WHOLE bootstrap, including a hung package manager/installer.
    // Kill the process group if it ignores TERM; auto_destroy then reaps it.
    init: { exec: ["/usr/bin/timeout", "--kill-after=10s", String(ttlSeconds), "/bin/bash", "-c", initScript] },
  };
}

/** Each launch owns a dedicated app. Delete it only after an authoritative
 * empty inventory; never force-delete an app containing someone else's VM. */
async function deleteEmptyFlyApp(exec: ExecFn, token: string, app: string): Promise<void> {
  if (!/^bivy-[a-z0-9-]+$/.test(app)) return;
  const url = `https://api.machines.dev/v1/apps/${encodeURIComponent(app)}`;
  const inventory = await call(exec, { method: "GET", url: `${url}/machines`, headers: bearer(token) });
  if (inventory.status === 404) return;
  if (inventory.status >= 300) throw new Error(providerError(inventory, "check empty app"));
  if (!Array.isArray(inventory.body)) throw new Error("Fly returned an invalid app inventory; keeping the app for cleanup retry");
  if (inventory.body.length) return;
  const deleted = await call(exec, { method: "DELETE", url, headers: bearer(token) });
  if (deleted.status >= 300 && deleted.status !== 404) throw new Error(providerError(deleted, "delete empty app"));
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
    { id: "shared-1x-1gb", label: "shared · 1 vCPU · 1 GB", vcpus: 1, memoryMiB: 1024, architecture: "x86_64", pricePerHour: 0.009, priceSource: "indicative" },
    { id: "shared-1x-2gb", label: "shared · 1 vCPU · 2 GB", vcpus: 1, memoryMiB: 2048, architecture: "x86_64", pricePerHour: 0.0136, priceSource: "indicative" },
    { id: "shared-2x-4gb", label: "shared · 2 vCPU · 4 GB", vcpus: 2, memoryMiB: 4096, architecture: "x86_64", pricePerHour: 0.0273, priceSource: "indicative" },
    { id: "shared-4x-8gb", label: "shared · 4 vCPU · 8 GB", vcpus: 4, memoryMiB: 8192, architecture: "x86_64", pricePerHour: 0.0546, priceSource: "indicative" },
    { id: "shared-8x-16gb", label: "shared · 8 vCPU · 16 GB", vcpus: 8, memoryMiB: 16384, architecture: "x86_64", pricePerHour: 0.1234, priceSource: "indicative" },
  ],
  // A normal coding agent routinely runs installs, compilers, tests and tool
  // subprocesses. 1–2 GB is an opt-in economy choice, not a safe default.
  defaultSize: "shared-4x-8gb",
  async validateToken({ exec, token }) {
    // Discover the org the token is scoped to (this alone rejects an invalid
    // token), then confirm it can reach the Machines API for that org — the
    // exact capability provisioning needs — so under-scoped tokens fail here.
    const org = await resolveFlyOrg(exec, token);
    const res = await call(exec, {
      method: "GET",
      url: `https://api.machines.dev/v1/apps?org_slug=${encodeURIComponent(org)}`,
      headers: bearer(token),
    });
    if (res.status >= 300) throw new Error(providerError(res, "validate credential"));
  },
  async provision({ exec, token, config, bootstrap }) {
    if (!bootstrap) throw new Error("Fly requires a structured Bivy bootstrap; cloud-init is not supported by Fly Machines.");
    const app = `bivy-${config.slug}`;
    const org = await resolveFlyOrg(exec, token, config.org);
    const guest = FLY_GUEST[config.size as string] || FLY_GUEST[flyProvider.defaultSize] || { cpus: 1, memoryMb: 2048, cpuKind: "shared" };
    const created = await call(exec, {
      method: "POST",
      url: "https://api.machines.dev/v1/apps",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: { app_name: app, org_slug: org },
    });
    // Fly returns 422 (not only 409) for an existing app name. Accept only
    // that specific validation conflict; inventory below must still prove
    // which attempt owns the machine before a retry can adopt it.
    const nameTaken = created.status === 422 && /name has already been taken/i.test(extractProviderMessage(created.body));
    if (created.status >= 300 && created.status !== 409 && !nameTaken) throw new Error(providerError(created, "create app"));
    // Fly app creation is naturally name-idempotent, but machine creation is
    // not. Adopt a machine carrying this attempt metadata before retrying create.
    if (config.attemptId) {
      const found = await call(exec, {
        method: "GET",
        url: `https://api.machines.dev/v1/apps/${encodeURIComponent(app)}/machines`,
        headers: bearer(token),
      });
      if (found.status >= 300) throw new Error(providerError(found, "check existing launch"));
      if (!Array.isArray(found.body)) throw new Error("Fly returned an invalid machine inventory; refusing to risk a duplicate launch");
      const existing = found.body.find((m: any) => m?.config?.metadata?.["bivy-attempt"] === String(config.attemptId));
      if (found.status < 300 && existing?.id) {
        return { id: String(existing.id), provider: "fly", app, name: app, region: existing.region || config.region || "iad", status: mapFlyStatus(existing.state), ip: null, createdAt: existing.created_at || nowIso(), ttlMinutes: config.ttlMinutes };
      }
      if (found.body.length) throw new Error("This Fly app already contains a machine from another launch. Reconnect or destroy it before rebuilding.");
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
    // without ever relying on cloud-init user_data.
    const machineInit = flyInit(bootstrap);
    const machine = await call(exec, {
      method: "POST",
      url: `https://api.machines.dev/v1/apps/${encodeURIComponent(app)}/machines`,
      headers: { ...bearer(token), "content-type": "application/json" },
      body: {
        region: config.region || "iad",
        config: {
          image: config.image || FLY_RUNNER_IMAGE,
          // DEBUG: when keeping failed machines, don't auto-destroy — a boot
          // failure then stops the machine (logs retained) instead of vanishing.
          auto_destroy: bootstrap?.debugKeepMachine ? false : true,
          restart: { policy: "no" },
          guest: { cpu_kind: guest.cpuKind, cpus: Number(config.cpus) || guest.cpus, memory_mb: Number(config.memoryMb) || guest.memoryMb },
          metadata: {
            bivy: "ephemeral",
            ...(config.attemptId ? { "bivy-attempt": String(config.attemptId) } : {}),
            ...(config.ownershipTag ? { "bivy-account": String(config.ownershipTag) } : {}),
          },
          ...machineInit,
        },
      },
    });
    if (machine.status >= 300) {
      // A transport timeout/5xx can hide an accepted create. Keep the stable
      // app/attempt identity in that case so reconciliation can adopt it.
      if (created.status < 300 && machine.status >= 400 && machine.status < 500 && ![408, 409, 429].includes(machine.status)) {
        await deleteEmptyFlyApp(exec, token, app);
      }
      throw new Error(providerError(machine, "create machine"));
    }
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
    await deleteEmptyFlyApp(exec, token, machine.app || "");
  },
  // Fly has no account-wide "list machines by tag" call — a Machine is scoped
  // to its app. Discovery instead lists every `bivy-`-prefixed app reachable
  // with this token and checks each one's machines for the ownership tag.
  // Bounded by how many bivy- apps exist for the token (normally very few);
  // one app's list call failing is skipped rather than aborting the scan.
  async cleanupAttempt({ exec, token, nodeId, attemptId, ownershipTag }) {
    // The launch plan uses this exact, server-enrolled node identity as its slug.
    if (!/^eph-(?:[a-f0-9]{16}|[a-f0-9]{32})$/.test(nodeId)) return false;
    const app = `bivy-${nodeId.replace(/^eph-/, "")}`;
    const url = `https://api.machines.dev/v1/apps/${encodeURIComponent(app)}`;
    const inventory = await call(exec, { method: "GET", url: `${url}/machines`, headers: bearer(token) });
    if (inventory.status !== 404) {
      if (inventory.status >= 300 || !Array.isArray(inventory.body)) throw new Error("Cannot verify canceled Fly launch inventory");
      if (inventory.body.some((m: any) => m?.config?.metadata?.["bivy-attempt"] !== attemptId || m?.config?.metadata?.["bivy-account"] !== ownershipTag)) return false;
      for (const machine of inventory.body) {
        if (!machine?.id) return false;
        const deleted = await call(exec, { method: "DELETE", url: `${url}/machines/${encodeURIComponent(machine.id)}?force=true`, headers: bearer(token) });
        if (deleted.status >= 300 && deleted.status !== 404) return false;
      }
      // Empty dedicated apps are resources too; discovery of machines alone
      // cannot find this common image-pull failure window.
      const removed = await call(exec, { method: "DELETE", url, headers: bearer(token) });
      if (removed.status >= 300 && removed.status !== 404) return false;
    }
    const confirmed = await call(exec, { method: "GET", url, headers: bearer(token) });
    return confirmed.status === 404;
  },
  async discover({ exec, token, ownershipTag }) {
    const org = await resolveFlyOrg(exec, token);
    const appsRes = await call(exec, { method: "GET", url: `https://api.machines.dev/v1/apps?org_slug=${encodeURIComponent(org)}`, headers: bearer(token) });
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
