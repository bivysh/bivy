#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Dispatcher for E2B sandboxes (DISPATCH.md). Written against E2B's OpenAPI
// spec and envd API; see dispatchers/README.md for what it needs.
//
//   FLEET_PROVIDER=command
//   FLEET_DISPATCH_COMMAND="node services/fleet/dispatchers/e2b.mjs"
//   E2B_API_KEY=…
//   E2B_TEMPLATE=…               (a template with Bivy installed; CPU and
//                                 memory are the template's, not the fleet's)
//   E2B_TIMEOUT_SECONDS=86400    (default; your plan's continuous-runtime cap)
//   E2B_API_URL=https://api.e2b.app, E2B_ENVD_URL=https://sandbox.e2b.app
//
// Stopping pauses the sandbox (filesystem kept, no compute billed, kept
// indefinitely); a start resumes it and runs the boot script again, because
// the node exited before the pause.

import { APP_LABEL, BOOT_SCRIPT, START_BOOT, api, bootScript, need, serve } from "./common.mjs";

const control = () => (process.env.E2B_API_URL?.trim() || "https://api.e2b.app").replace(/\/$/, "");
const envd = () => (process.env.E2B_ENVD_URL?.trim() || "https://sandbox.e2b.app").replace(/\/$/, "");
const timeout = () => Number(process.env.E2B_TIMEOUT_SECONDS || 86_400);
const headers = (extra = {}) => ({ "x-api-key": need("E2B_API_KEY"), ...extra });
const json = (body) => ({ headers: headers({ "content-type": "application/json" }), body: JSON.stringify(body) });
const ENVD_PORT = "49983";
const ROOT = `Basic ${Buffer.from("root:").toString("base64")}`;

const STATES = { running: "started", paused: "stopped" };
const machineFrom = (box) => ({ id: box.sandboxID, state: STATES[box.state] ?? "started", region: "", createdAt: box.startedAt });

/** In-sandbox calls go to envd, addressed by headers, as root. */
const envdHeaders = (id, token, extra = {}) => ({ "e2b-sandbox-id": id, "e2b-sandbox-port": ENVD_PORT, "x-access-token": token, authorization: ROOT, ...extra });

async function writeFile(id, token, path, content) {
  const form = new FormData();
  form.append("file", new Blob([content]), path.split("/").pop());
  await api(`${envd()}/files?path=${encodeURIComponent(path)}&username=root`, { method: "POST", headers: envdHeaders(id, token), body: form });
}

/** Start the node in the background. envd's process API is Connect RPC with
 * framed JSON: a flags byte, a big-endian length, the message. The shell
 * returns at once; the node keeps running detached. */
async function startBoot(id, token) {
  const message = Buffer.from(JSON.stringify({ process: { cmd: "/bin/bash", args: ["-c", START_BOOT] }, stdin: false }));
  const frame = Buffer.alloc(5 + message.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(message.length, 1);
  message.copy(frame, 5);
  const res = await fetch(`${envd()}/process.Process/Start`, {
    method: "POST",
    headers: envdHeaders(id, token, { "content-type": "application/connect+json", "connect-protocol-version": "1" }),
    body: frame,
    signal: AbortSignal.timeout(120_000),
  });
  const body = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`start boot: ${res.status} ${body.toString("utf8").slice(0, 300)}`);
  // Errors arrive in the end-of-stream frame (flags 2) under HTTP 200.
  for (let at = 0; at + 5 <= body.length;) {
    const flags = body.readUInt8(at);
    const length = body.readUInt32BE(at + 1);
    const payload = JSON.parse(body.subarray(at + 5, at + 5 + length).toString("utf8") || "{}");
    if (flags & 2 && payload.error) throw new Error(`start boot: ${payload.error.message ?? JSON.stringify(payload.error)}`);
    const end = payload.event?.end;
    if (end && end.exitCode && end.exitCode !== 0) throw new Error(`start boot exited ${end.exitCode}`);
    at += 5 + length;
  }
}

async function byApp(app) {
  const metadata = encodeURIComponent(`${APP_LABEL}=${encodeURIComponent(app)}`);
  const listed = await api(`${control()}/v2/sandboxes?metadata=${metadata}&state=running,paused&limit=100`, { headers: headers() });
  return Array.isArray(listed) ? listed : [];
}

await serve({
  describe: () => ({ capabilities: { stopsOnExit: false, keepsMemory: false, cpuReading: false } }),
  ensureVolume: () => ({ volumeId: "" }),
  createVolume: () => ({ volumeId: "" }),

  async createMachine({ app, spec }) {
    const box = await api(`${control()}/v2/sandboxes`, {
      method: "POST",
      ...json({ templateID: need("E2B_TEMPLATE"), timeout: timeout(), autoPause: true, autoPauseMemory: false, metadata: { [APP_LABEL]: app } }),
    });
    for (const file of spec.files) await writeFile(box.sandboxID, box.envdAccessToken, file.guest_path, Buffer.from(file.raw_value, "base64"));
    await writeFile(box.sandboxID, box.envdAccessToken, BOOT_SCRIPT, bootScript(spec));
    await startBoot(box.sandboxID, box.envdAccessToken);
    return { machine: machineFrom({ ...box, state: "running" }) };
  },

  async updateMachine({ machineId, spec }) {
    // A template can't change under a sandbox; the new boot payload is
    // written now and used on the next start.
    const box = await api(`${control()}/v2/sandboxes/${encodeURIComponent(machineId)}/connect`, { method: "POST", ...json({ timeout: timeout() }) });
    for (const file of spec.files) await writeFile(machineId, box.envdAccessToken, file.guest_path, Buffer.from(file.raw_value, "base64"));
    await writeFile(machineId, box.envdAccessToken, BOOT_SCRIPT, bootScript(spec));
    await api(`${control()}/sandboxes/${encodeURIComponent(machineId)}/pause`, { method: "POST", ...json({ memory: false }) });
    return { machine: { id: machineId, state: "stopped", region: "" } };
  },

  async getMachine({ machineId }) {
    const box = await api(`${control()}/sandboxes/${encodeURIComponent(machineId)}`, { headers: headers(), allow404: true });
    return { machine: box ? machineFrom(box) : null };
  },

  async startMachine({ machineId }) {
    const box = await api(`${control()}/v2/sandboxes/${encodeURIComponent(machineId)}/connect`, { method: "POST", ...json({ timeout: timeout() }) });
    await startBoot(machineId, box.envdAccessToken);
  },

  async stopMachine({ machineId }) {
    await api(`${control()}/sandboxes/${encodeURIComponent(machineId)}/pause`, { method: "POST", ...json({ memory: false }), allow404: true });
  },

  async destroyMachine({ machineId }) {
    if (machineId) await api(`${control()}/sandboxes/${encodeURIComponent(machineId)}`, { method: "DELETE", headers: headers(), allow404: true });
  },

  async destroyAll({ app }) {
    for (const box of await byApp(app)) await api(`${control()}/sandboxes/${encodeURIComponent(box.sandboxID)}`, { method: "DELETE", headers: headers(), allow404: true });
  },

  async listApps({ prefix }) {
    const listed = await api(`${control()}/v2/sandboxes?state=running,paused&limit=100`, { headers: headers() });
    const boxes = Array.isArray(listed) ? listed : [];
    return { apps: [...new Set(boxes.map((box) => box.metadata?.[APP_LABEL]).filter((app) => typeof app === "string" && app.startsWith(prefix)))] };
  },
});
