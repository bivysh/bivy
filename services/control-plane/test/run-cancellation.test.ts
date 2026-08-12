// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port")));
    });
    server.on("error", reject);
  });
}

async function request(port: number, method: string, pathname: string, token?: string, body?: unknown) {
  const response = await fetch(`http://localhost:${port}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
}

let proc: ChildProcess | undefined;
let relay: Server | undefined;
try {
  const [port, relayPort] = await Promise.all([freePort(), freePort()]);
  const relayNotifications: any[] = [];
  relay = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    relayNotifications.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => relay!.listen(relayPort, resolve));

  proc = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: cpDir,
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_PUBLIC_URL: `ws://localhost:${relayPort}`,
      RELAY_SECRET: "cancel-test",
      ENFORCE_ENTITLEMENTS: "0",
      AUTOMATION_SCHEDULER_INTERVAL_MS: "60000",
    },
    stdio: "inherit",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${port}/healthz`)).ok) break; } catch {}
    if (i === 99) throw new Error("Control plane did not start");
    await delay(100);
  }

  const login = await request(port, "POST", "/auth/dev-login", undefined, { email: "cancel-api@example.com" });
  const otherLogin = await request(port, "POST", "/auth/dev-login", undefined, { email: "cancel-other@example.com" });
  const token = login.body.token as string;
  const otherToken = otherLogin.body.token as string;
  assert.ok(token && otherToken);

  const unauthorized = await request(port, "POST", "/account/automation-runs/nope/cancel");
  assert.equal(unauthorized.status, 401);

  const enrollment = await request(port, "POST", "/nodes/enroll", token, { nodeId: "cancel-node", name: "cancel-runner" });
  const nodeToken = enrollment.body.enrollmentToken as string;
  assert.ok(nodeToken);

  const active = await request(port, "POST", "/account/automation-runs", token, { title: "Active cancellation", label: "bivy/cancel-runner" });
  assert.equal(active.status, 201);
  assert.equal((await request(port, "POST", `/node/work/${active.body.id}/claim`, nodeToken)).status, 200);
  assert.equal((await request(port, "POST", `/node/work/${active.body.id}/running`, nodeToken)).status, 200);

  const crossAccount = await request(port, "POST", `/account/automation-runs/${active.body.id}/cancel`, otherToken);
  assert.equal(crossAccount.status, 404, "cross-account cancellation must not reveal the run");

  const cancelled = await request(port, "POST", `/account/automation-runs/${active.body.id}/cancel`, token);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.run.status, "cancelled");
  assert.equal(cancelled.body.run.leaseExpiresAt, undefined);
  assert.equal(cancelled.body.run.events.at(-1).kind, "cancelled");
  const completedAt = cancelled.body.run.completedAt;
  const eventCount = cancelled.body.run.events.length;

  const repeated = await request(port, "POST", `/account/automation-runs/${active.body.id}/cancel`, token);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.run.completedAt, completedAt);
  assert.equal(repeated.body.run.events.length, eventCount, "idempotent cancellation must not append evidence");

  const heartbeat = await request(port, "POST", `/node/work/${active.body.id}/heartbeat`, nodeToken);
  assert.equal(heartbeat.status, 409);
  assert.equal(heartbeat.body.reason, "cancelled");

  for (let i = 0; i < 50 && !relayNotifications.some((n) => n.id === active.body.id && n.nodeId === "cancel-node"); i++) await delay(20);
  assert.ok(
    relayNotifications.some((n) => n.id === active.body.id && n.nodeId === "cancel-node"),
    "cancellation wakes only the active owner through the relay",
  );

  const finished = await request(port, "POST", "/account/automation-runs", token, { title: "Already complete" });
  assert.equal((await request(port, "POST", `/node/work/${finished.body.id}/claim`, nodeToken)).status, 200);
  assert.equal((await request(port, "POST", `/node/work/${finished.body.id}/running`, nodeToken)).status, 200);
  assert.equal((await request(port, "POST", `/node/work/${finished.body.id}/complete`, nodeToken)).status, 200);
  const conflict = await request(port, "POST", `/account/automation-runs/${finished.body.id}/cancel`, token);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.status, "succeeded");

  const metrics = await (await fetch(`http://localhost:${port}/metrics`)).text();
  assert.match(metrics, /bivy_run_lifecycle_results_total\{outcome="cancelled"\} 1(?:\n|$)/, "only the durable cancellation transition is counted");
  console.log("✓ authenticated run cancellation API, owner wake, heartbeat, conflicts, and metric");
} finally {
  proc?.kill("SIGTERM");
  if (relay) await new Promise<void>((resolve) => relay!.close(() => resolve()));
}
