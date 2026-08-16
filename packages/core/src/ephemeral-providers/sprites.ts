// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Fly Sprites provider interpreter.
import { bivyNodeEnv } from "../ephemeral-provider-bootstrap.js";
import { ephemeralCatalogEntry } from "../ephemeral-catalog.js";
import type { ProviderAdapter, ProviderSize } from "../ephemeral-provider-ports.js";
import { bearer, call, nowIso, providerError, shq } from "../ephemeral-provider-utils.js";

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
  { id: "2x4", label: "2 vCPU · 4 GB", vcpus: 2, memoryMiB: 4096, architecture: "x86_64", pricePerHour: 0.06, priceSource: "indicative" },
  { id: "4x8", label: "4 vCPU · 8 GB", vcpus: 4, memoryMiB: 8192, architecture: "x86_64", pricePerHour: 0.115, priceSource: "indicative" },
  { id: "8x8", label: "8 vCPU · 8 GB", vcpus: 8, memoryMiB: 8192, architecture: "x86_64", pricePerHour: 0.16, priceSource: "indicative" },
  { id: "8x16", label: "8 vCPU · 16 GB", vcpus: 8, memoryMiB: 16384, architecture: "x86_64", pricePerHour: 0.22, priceSource: "indicative" },
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
export const spritesProvider: ProviderAdapter = {
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
    const guest = SPRITES_GUEST[config.size as string] || SPRITES_GUEST[spritesProvider.defaultSize] || { cpus: 4, ramMb: 8192 };
    // 1. Create the sprite.
    const created = await call(exec, {
      method: "POST",
      url: `${SPRITES_HOST}/v1/sprites`,
      headers: { ...bearer(token), "content-type": "application/json" },
      body: {
        name,
        config: { cpus: guest.cpus, ram_mb: guest.ramMb, region: config.region || spritesProvider.defaultRegion },
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
      region: config.region || spritesProvider.defaultRegion,
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
