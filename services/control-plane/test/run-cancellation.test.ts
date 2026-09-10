// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawnTestService, stopTestServices } from "../../test-service-process.js";
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

async function request(port: number, method: string, pathname: string, token?: string, body?: unknown, claimToken?: string) {
  const response = await fetch(`http://localhost:${port}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(claimToken ? { 'x-bivy-work-claim': claimToken } : {}) },
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

  proc = spawnTestService(cpDir, {
    PORT: String(port),
    RELAY_PUBLIC_URL: `ws://localhost:${relayPort}`,
    RELAY_SECRET: "cancel-test",
    AUTOMATION_SCHEDULER_INTERVAL_MS: "60000",
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

  // Routable single-Run fetch backing /runs/:runId. Auth is required, an unknown
  // id and a cross-account id are indistinguishable (a non-leaking 404), and the
  // owner reads the durable record.
  assert.equal((await request(port, "GET", `/account/automation-runs/${active.body.id}`)).status, 401);
  assert.equal((await request(port, "GET", "/account/automation-runs/does-not-exist", token)).status, 404, "an unknown Run id returns a non-leaking 404");
  assert.equal((await request(port, "GET", `/account/automation-runs/${active.body.id}`, otherToken)).status, 404, "a cross-account Run id is indistinguishable from unknown");
  const ownGet = await request(port, "GET", `/account/automation-runs/${active.body.id}`, token);
  assert.equal(ownGet.status, 200);
  assert.equal(ownGet.body.id, active.body.id);

  const cancelled = await request(port, "POST", `/account/automation-runs/${active.body.id}/cancel`, token);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.run.status, "cancelled");
  assert.equal(cancelled.body.run.leaseExpiresAt, undefined);
  assert.equal(cancelled.body.run.events.at(-1).kind, "terminal");
  assert.equal(cancelled.body.run.events.at(-2).kind, "cancel_requested");
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

  assert.equal((await request(port, "POST", `/account/automation-runs/${finished.body.id}/retry`)).status, 401);
  assert.equal((await request(port, "POST", `/account/automation-runs/${finished.body.id}/retry`, otherToken)).status, 404);
  const retried = await request(port, "POST", `/account/automation-runs/${finished.body.id}/retry`, token);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.run.id, finished.body.id);
  assert.equal(retried.body.run.status, "pending");
  assert.equal(retried.body.run.attempt, 2);
  assert.equal(retried.body.run.events.at(-1).kind, "retry");

  const successful = await request(port, "POST", "/account/automation-runs", token, { title: "Successful artifact" });
  assert.equal((await request(port, "POST", `/node/work/${successful.body.id}/claim`, nodeToken)).status, 200);
  assert.equal((await request(port, "POST", `/node/work/${successful.body.id}/running`, nodeToken)).status, 200);
  assert.equal((await request(port, "POST", `/node/work/${successful.body.id}/evidence`, nodeToken, { output: { branch: "bivy/success" } })).status, 200);
  assert.equal((await request(port, "POST", `/node/work/${successful.body.id}/complete`, nodeToken)).status, 200);
  const noRetry = await request(port, "POST", `/account/automation-runs/${successful.body.id}/retry`, token);
  assert.equal(noRetry.status, 409);
  assert.equal(noRetry.body.reason, "not_retryable");

  const metrics = await (await fetch(`http://localhost:${port}/metrics`)).text();
  assert.match(metrics, /bivy_run_lifecycle_results_total\{outcome="cancelled"\} 1(?:\n|$)/, "only the durable cancellation transition is counted");
  const modern = await request(port, 'POST', '/account/automation-runs', token, {title:'Fenced delivery',maxAttempts:2});
  const claimToken = 'new-worker-generation';
  const work = `/node/work/${modern.body.id}`;
  const claimed = await request(port,'POST',`${work}/claim`,nodeToken,undefined,claimToken);
  assert.equal(claimed.body.item.claimToken,claimToken);
  for (const action of ['running','heartbeat','evidence','complete','fail','needs-attention']) {
    assert.equal((await request(port,'POST',`${work}/${action}`,nodeToken,{},'old-worker-generation')).status,409);
    assert.equal((await request(port,'POST',`${work}/${action}`,nodeToken,{})).status,409,'legacy requests cannot mutate a fenced claim');
  }
  assert.equal((await request(port,'POST',`${work}/running`,nodeToken,undefined,claimToken)).status,200);
  const reservation = await request(port,'POST',`${work}/attempt`,nodeToken,{attempt:1},claimToken);
  assert.equal(reservation.body.item.attempt,2);
  assert.equal((await request(port,'POST',`${work}/attempt`,nodeToken,{attempt:1},claimToken)).body.item.attempt,2);
  assert.equal((await request(port,'POST',`${work}/attempt`,nodeToken,{attempt:2},claimToken)).status,409);
  assert.equal((await request(port,'POST',`${work}/complete`,nodeToken,undefined,claimToken)).status,200);
  const beforeAck = await (await fetch(`http://localhost:${port}/metrics`)).text();
  assert.equal((await request(port,'POST',`${work}/complete`,nodeToken,undefined,claimToken)).status,200,'lost completion response can be retried');
  const afterAck = await (await fetch(`http://localhost:${port}/metrics`)).text();
  assert.equal(afterAck.match(/bivy_run_lifecycle_results_total\{outcome="succeeded"\} \d+/)?.[0],beforeAck.match(/bivy_run_lifecycle_results_total\{outcome="succeeded"\} \d+/)?.[0]);

  const definition = await request(port,'POST','/account/automations',token,{name:'Manual dispatch',trigger:'manual',templateCiphertext:'bivy-room-v1:cancel-node:opaque',nodeLabel:'bivy/cancel-runner'});
  assert.equal(definition.status,201,JSON.stringify(definition.body));
  const dispatchPath = `/account/automations/${definition.body.id}/run`;
  const first = await request(port,'POST',dispatchPath,token,{sourceKey:'click-1'});
  const duplicate = await request(port,'POST',dispatchPath,token,{sourceKey:'click-1'});
  const next = await request(port,'POST',dispatchPath,token,{sourceKey:'click-2'});
  assert.equal(first.status,201);
  assert.equal(duplicate.body.id,first.body.id);
  assert.notEqual(next.body.id,first.body.id);
  assert.equal((await request(port,'POST',dispatchPath,token,{sourceKey:{bad:true}})).status,400);
  console.log("✓ authenticated cancel/retry, generation fencing, attempt reservation, idempotent dispatch/result delivery and metrics");
} finally {
  await stopTestServices(proc ? [proc] : []);
  if (relay) await new Promise<void>((resolve) => relay!.close(() => resolve()));
}
