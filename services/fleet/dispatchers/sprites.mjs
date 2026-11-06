#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Dispatcher for Fly Sprites (DISPATCH.md). Written against the Sprites API
// reference; see dispatchers/README.md for what it needs.
//
//   FLEET_PROVIDER=command
//   FLEET_DISPATCH_COMMAND="node services/fleet/dispatchers/sprites.mjs"
//   SPRITES_TOKEN=<org>/<id>/<secret>
//   SPRITES_API_URL=https://api.sprites.dev   (default)
//
// A sprite has no stop or wake call: it pauses by itself once nothing is
// happening (no API request, no open connection, no output) and wakes on the
// next request. The node is a sprite *service*, started at every boot; its
// relay connection keeps the sprite awake. Stopping stops the service, so the
// sprite goes idle and pauses; starting starts it again, which also wakes it.
// Sprites use their own Ubuntu base, not the fleet's image: the boot script
// installs Bivy on first boot when it's missing.

import { APP_LABEL, BOOT_SCRIPT, api, bootScript, need, serve } from "./common.mjs";

const base = () => (process.env.SPRITES_API_URL?.trim() || "https://api.sprites.dev").replace(/\/$/, "");
const headers = (extra = {}) => ({ authorization: `Bearer ${need("SPRITES_TOKEN")}`, ...extra });
const SERVICE = "bivy";

// No labels on sprites: a machine is named `<app>--<suffix>`, so an app's
// machines are found by name prefix.
const nameFor = (app) => `${app}--${Math.random().toString(36).slice(2, 8)}`;
const appOf = (name) => (name.includes("--") ? name.slice(0, name.lastIndexOf("--")) : undefined);

const STATES = { running: "started", warm: "stopped", cold: "stopped" };
const sprite = (name) => api(`${base()}/v1/sprites/${encodeURIComponent(name)}`, { headers: headers(), allow404: true });

async function writeFile(name, path, content) {
  const query = new URLSearchParams({ path, workingDir: "/", mkdir: "true", mode: "0600" });
  await api(`${base()}/v1/sprites/${encodeURIComponent(name)}/fs/write?${query}`, { method: "PUT", headers: headers({ "content-type": "application/octet-stream" }), body: content });
}

const service = (name, action) => api(`${base()}/v1/sprites/${encodeURIComponent(name)}/services/${SERVICE}/${action}`, { method: "POST", headers: headers(), allow404: true });

async function byPrefix(prefix) {
  const out = [];
  let token = "";
  do {
    const query = new URLSearchParams({ prefix, max_results: "500", ...(token ? { continuation_token: token } : {}) });
    const page = await api(`${base()}/v1/sprites?${query}`, { headers: headers() });
    out.push(...(Array.isArray(page?.sprites) ? page.sprites : []));
    token = page?.has_more ? String(page.next_continuation_token ?? "") : "";
  } while (token);
  return out;
}

await serve({
  describe: () => ({ capabilities: { stopsOnExit: false, keepsMemory: false, cpuReading: false } }),
  ensureVolume: () => ({ volumeId: "" }),
  createVolume: () => ({ volumeId: "" }),

  async createMachine({ app, spec }) {
    const name = nameFor(app);
    const created = await api(`${base()}/v1/sprites`, { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify({ name }) });
    for (const file of spec.files) await writeFile(name, file.guest_path, Buffer.from(file.raw_value, "base64"));
    await writeFile(name, BOOT_SCRIPT, bootScript(spec));
    await api(`${base()}/v1/sprites/${encodeURIComponent(name)}/services/${SERVICE}`, {
      method: "PUT",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ cmd: "bash", args: [BOOT_SCRIPT], needs: [], env: { [APP_LABEL]: app } }),
    });
    await service(name, "start");
    return { machine: { id: name, state: "started", region: "", createdAt: created?.created_at } };
  },

  async updateMachine({ machineId, spec }) {
    for (const file of spec.files) await writeFile(machineId, file.guest_path, Buffer.from(file.raw_value, "base64"));
    await writeFile(machineId, BOOT_SCRIPT, bootScript(spec));
    return { machine: { id: machineId, state: "stopped", region: "" } };
  },

  async getMachine({ machineId }) {
    const found = await sprite(machineId);
    return { machine: found ? { id: machineId, state: STATES[found.status] ?? "stopped", region: "", createdAt: found.created_at } : null };
  },

  startMachine: ({ machineId }) => service(machineId, "start"),
  stopMachine: ({ machineId }) => service(machineId, "stop"),

  async destroyMachine({ machineId }) {
    if (machineId) await api(`${base()}/v1/sprites/${encodeURIComponent(machineId)}`, { method: "DELETE", headers: headers(), allow404: true });
  },

  async destroyAll({ app }) {
    for (const found of await byPrefix(`${app}--`)) await api(`${base()}/v1/sprites/${encodeURIComponent(found.name)}`, { method: "DELETE", headers: headers(), allow404: true });
  },

  async listApps({ prefix }) {
    return { apps: [...new Set((await byPrefix(prefix)).map((found) => appOf(found.name)).filter((app) => app && app.startsWith(prefix)))] };
  },
});
