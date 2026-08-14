// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// E2B sandbox provider interpreter.
import { bivyNodeEnv } from "../ephemeral-provider-bootstrap.js";
import { ephemeralCatalogEntry } from "../ephemeral-catalog.js";
import type { ProviderAdapter, ProviderSize } from "../ephemeral-provider-ports.js";
import { call, nowIso, providerError } from "../ephemeral-provider-utils.js";

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

export const e2bProvider: ProviderAdapter = {
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
    const size = (config.size as string) || e2bProvider.defaultSize;
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
      region: e2bProvider.defaultRegion,
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
