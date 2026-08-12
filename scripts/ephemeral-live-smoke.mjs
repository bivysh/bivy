#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Credential-gated smoke against a deployed control plane and a dedicated test
// account. Cleanup runs in finally and the test fails unless every runner it
// created disappears from Bivy's provider-confirmed hosted inventory.

const base = String(process.env.BIVY_SMOKE_CONTROL_PLANE_URL || "").replace(/\/$/, "");
const accountToken = String(process.env.BIVY_SMOKE_ACCOUNT_TOKEN || "");
const provider = String(process.env.BIVY_SMOKE_PROVIDER || "hetzner");
const providerToken = String(process.env.BIVY_SMOKE_PROVIDER_TOKEN || "");
const region = String(process.env.BIVY_SMOKE_REGION || "");
const size = String(process.env.BIVY_SMOKE_SIZE || "");
const image = String(process.env.BIVY_SMOKE_IMAGE || "");
const maxSeconds = Math.max(30, Number(process.env.BIVY_SMOKE_MAX_SECONDS || 600));
const enforceSlo = process.env.BIVY_SMOKE_ENFORCE_10S === "1";

if (!base || !accountToken || !providerToken) throw new Error("control-plane URL, account token, and provider token are required");
const headers = { authorization: `Bearer ${accountToken}`, "content-type": "application/json" };
const createdNodeIds = new Set();
let configId = "";

async function api(path, init = {}) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path}: ${res.status} ${data?.error || JSON.stringify(data)}`);
  return data;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cleanup() {
  const errors = [];
  const machines = await api("/account/hosted-machines").catch(() => []);
  for (const machine of machines) {
    if (!createdNodeIds.has(machine.nodeId) && machine.setupId !== configId) continue;
    createdNodeIds.add(machine.nodeId);
    await api(`/account/hosted-machines/${encodeURIComponent(machine.nodeId)}`, { method: "DELETE" }).catch((error) => errors.push(error));
  }
  if (configId) await api(`/account/ephemeral-configs/${encodeURIComponent(configId)}`, { method: "DELETE" }).catch((error) => errors.push(error));
  await api("/account/queue-routing", { method: "PUT", body: JSON.stringify({ primary: { kind: "shared" } }) }).catch((error) => errors.push(error));
  await api("/account/hosted-provisioning", { method: "PUT", body: JSON.stringify({ enabled: false }) }).catch((error) => errors.push(error));
  const leaked = (await api("/account/hosted-machines").catch(() => [])).filter((m) => createdNodeIds.has(m.nodeId) || m.setupId === configId);
  if (leaked.length) errors.push(new Error(`cleanup failed; ${leaked.length} smoke runner(s) remain tracked: ${leaked.map((m) => m.nodeId).join(", ")}`));
  if (errors.length) throw new AggregateError(errors, "one or more live-smoke cleanup steps failed");
}

let failure;
try {
  await api("/account/hosted-provisioning/validate-provider", {
    method: "POST", body: JSON.stringify({ provider, token: providerToken, region: region || undefined }),
  });
  await api("/account/hosted-provisioning", {
    method: "PUT", body: JSON.stringify({ enabled: true, providerTokens: { [provider]: providerToken } }),
  });
  const config = await api("/account/ephemeral-configs", {
    method: "POST",
    body: JSON.stringify({ name: `live-smoke-${Date.now()}`, provider, region: region || undefined, size: size || undefined, image: image || undefined, ttlMinutes: 15, teardownOnAgentFinish: true }),
  });
  configId = config.id;
  await api("/account/queue-routing", { method: "PUT", body: JSON.stringify({ primary: { kind: "config", configId } }) });
  const requestedAt = Date.now();
  await api("/account/automation-runs", { method: "POST", body: JSON.stringify({ title: `Ephemeral live smoke ${new Date().toISOString()}` }) });

  let ready;
  const deadline = requestedAt + maxSeconds * 1000;
  while (Date.now() < deadline) {
    const machines = await api("/account/hosted-machines");
    for (const machine of machines) {
      if (machine.setupId === configId) createdNodeIds.add(machine.nodeId);
      if (machine.setupId === configId && machine.milestones?.firstAgentEventAt) ready = machine;
    }
    if (ready) break;
    await delay(2000);
  }
  if (!ready) throw new Error(`no first agent event within ${maxSeconds}s`);
  const start = Date.parse(ready.milestones.requestedAt || "") || requestedAt;
  const elapsedMs = Date.parse(ready.milestones.firstAgentEventAt) - start;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error("runner returned invalid cold-start milestones");
  console.log(JSON.stringify({ provider, nodeId: ready.nodeId, elapsedMs, milestones: ready.milestones }, null, 2));
  if (enforceSlo && elapsedMs >= 10_000) throw new Error(`first-agent-event SLO missed: ${elapsedMs}ms >= 10000ms`);
} catch (error) {
  failure = error;
} finally {
  try { await cleanup(); } catch (cleanupError) { failure = failure ? new AggregateError([failure, cleanupError]) : cleanupError; }
}
if (failure) throw failure;
