#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Dispatcher for Daytona sandboxes (DISPATCH.md). Written against Daytona's
// REST API reference; see dispatchers/README.md for what it needs.
//
//   FLEET_PROVIDER=command
//   FLEET_DISPATCH_COMMAND="node services/fleet/dispatchers/daytona.mjs"
//   DAYTONA_API_KEY=…            (Bearer; tied to one organization)
//   DAYTONA_SNAPSHOT=…           (optional: a snapshot with Bivy installed;
//                                 otherwise the fleet's image is built FROM)
//   DAYTONA_API_URL=https://app.daytona.io/api   (default)
//
// A Daytona sandbox keeps its filesystem when stopped but not its processes,
// so every start runs the boot script again. Auto-stop is turned off: it only
// counts API calls, not a running node, and the fleet stops the sandbox when
// the node says it's going to sleep.

import { APP_LABEL, BOOT_SCRIPT, START_BOOT, api, bootScript, need, serve, sizeOf } from "./common.mjs";

const base = () => (process.env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api").replace(/\/$/, "");
const headers = (extra = {}) => ({ authorization: `Bearer ${need("DAYTONA_API_KEY")}`, ...extra });
const json = (body) => ({ headers: headers({ "content-type": "application/json" }), body: JSON.stringify(body) });

/** Daytona's states, folded into the fleet's (DISPATCH.md, Terms). */
const STATES = {
  started: "started",
  creating: "starting", starting: "starting", restoring: "starting", resuming: "starting",
  pending_build: "starting", building_snapshot: "starting", pulling_snapshot: "starting",
  destroyed: "destroyed", destroying: "destroying",
};
const machineFrom = (sandbox) => ({ id: sandbox.id, state: STATES[sandbox.state] ?? "stopped", region: sandbox.target ?? "", createdAt: sandbox.createdAt });

const sandbox = (id) => api(`${base()}/sandbox/${encodeURIComponent(id)}`, { headers: headers(), allow404: true });

/** The toolbox API runs commands and writes files inside a sandbox. */
async function toolbox(id) {
  const box = await sandbox(id);
  if (!box) throw new Error(`sandbox ${id} is gone`);
  return `${String(box.toolboxProxyUrl || "https://proxy.app.daytona.io/toolbox").replace(/\/$/, "")}/${encodeURIComponent(id)}`;
}

async function writeFile(root, path, content) {
  const form = new FormData();
  form.append("file", new Blob([content]), path.split("/").pop());
  await api(`${root}/files/upload-v2?path=${encodeURIComponent(path)}`, { method: "POST", headers: headers(), body: form });
}

/** Wait until the sandbox is started, then write the boot payload (on
 * create) and start the node in the background. */
async function boot(id, spec) {
  for (let i = 0; i < 120; i++) {
    const box = await sandbox(id);
    if (box?.state === "started") break;
    if (box?.state === "error" || box?.state === "build_failed") throw new Error(`sandbox ${id}: ${box.state} ${box.errorReason ?? ""}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const root = await toolbox(id);
  if (spec) {
    for (const file of spec.files) await writeFile(root, file.guest_path, Buffer.from(file.raw_value, "base64"));
    await writeFile(root, BOOT_SCRIPT, bootScript(spec));
  }
  const session = `bivy-${Date.now()}`;
  await api(`${root}/process/session`, { method: "POST", ...json({ sessionId: session }) });
  await api(`${root}/process/session/${session}/exec`, { method: "POST", ...json({ command: START_BOOT, runAsync: true }) });
}

async function byApp(app) {
  const query = encodeURIComponent(JSON.stringify({ [APP_LABEL]: app }));
  const listed = await api(`${base()}/sandbox?labels=${query}&limit=200`, { headers: headers() });
  return Array.isArray(listed?.items) ? listed.items : Array.isArray(listed) ? listed : [];
}

await serve({
  describe: () => ({ capabilities: { stopsOnExit: false, keepsMemory: false, cpuReading: false } }),
  ensureVolume: () => ({ volumeId: "" }),
  createVolume: () => ({ volumeId: "" }),

  async createMachine({ app, spec }) {
    const size = sizeOf(spec.size);
    const snapshot = process.env.DAYTONA_SNAPSHOT?.trim();
    const created = await api(`${base()}/sandbox`, {
      method: "POST",
      ...json({
        ...(snapshot ? { snapshot } : { buildInfo: { dockerfileContent: `FROM ${spec.image}\n` } }),
        user: "root",
        cpu: Math.min(size.cpus, 4),
        memory: Math.min(size.memoryGb, 8),
        labels: { [APP_LABEL]: app },
        autoStopInterval: 0,
        autoDeleteInterval: -1,
      }),
    });
    await boot(created.id, spec);
    return { machine: machineFrom({ ...created, state: "started" }) };
  },

  async updateMachine({ machineId, spec }) {
    // Daytona can't swap a sandbox's image in place; the new boot payload is
    // written on the next start. A new image takes a new sandbox.
    const root = await toolbox(machineId).catch(() => undefined);
    if (root) {
      for (const file of spec.files) await writeFile(root, file.guest_path, Buffer.from(file.raw_value, "base64"));
      await writeFile(root, BOOT_SCRIPT, bootScript(spec));
    }
    const box = await sandbox(machineId);
    return { machine: box ? machineFrom(box) : { id: machineId, state: "stopped", region: "" } };
  },

  async getMachine({ machineId }) {
    const box = await sandbox(machineId);
    return { machine: box ? machineFrom(box) : null };
  },

  async startMachine({ machineId }) {
    await api(`${base()}/sandbox/${encodeURIComponent(machineId)}/start`, { method: "POST", headers: headers() });
    await boot(machineId);
  },

  async stopMachine({ machineId }) {
    await api(`${base()}/sandbox/${encodeURIComponent(machineId)}/stop`, { method: "POST", headers: headers(), allow404: true });
  },

  async destroyMachine({ machineId }) {
    if (machineId) await api(`${base()}/sandbox/${encodeURIComponent(machineId)}`, { method: "DELETE", headers: headers(), allow404: true });
  },

  async destroyAll({ app }) {
    for (const box of await byApp(app)) await api(`${base()}/sandbox/${encodeURIComponent(box.id)}`, { method: "DELETE", headers: headers(), allow404: true });
  },

  async listApps({ prefix }) {
    const listed = await api(`${base()}/sandbox?limit=200`, { headers: headers() });
    const items = Array.isArray(listed?.items) ? listed.items : [];
    return { apps: [...new Set(items.map((box) => box.labels?.[APP_LABEL]).filter((app) => typeof app === "string" && app.startsWith(prefix)))] };
  },
});
