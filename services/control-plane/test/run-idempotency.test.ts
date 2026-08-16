// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Adversarial lifecycle: every accepted Run reaches exactly one explicit
// outcome, terminal outcomes are immutable, and a Machine that lost its lease to
// a reclaim cannot rewrite the new attempt or inflate outcome metrics. Boots the
// real control plane with a deliberately short work lease so reclaim is
// deterministic rather than clock-dependent.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
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
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port"))));
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
  return { status: response.status, body: (await response.json().catch(() => ({}))) as any };
}

/** Parse a single labelled counter value out of a Prometheus scrape. */
function metric(text: string, name: string, outcome: string): number {
  const line = text.split("\n").find((l) => l.startsWith(`${name}{outcome="${outcome}"}`));
  return line ? Number(line.trim().split(/\s+/).at(-1)) : 0;
}
function stageMetric(text: string, stage: string): number {
  const line = text.split("\n").find((l) => l.startsWith(`bivy_run_failure_stage_total{stage="${stage}"}`));
  return line ? Number(line.trim().split(/\s+/).at(-1)) : 0;
}
async function scrape(port: number): Promise<string> {
  return (await fetch(`http://localhost:${port}/metrics`)).text();
}

const LEASE_MS = 700;
let proc: ChildProcess | undefined;
try {
  const port = await freePort();
  proc = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: cpDir,
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_PUBLIC_URL: "ws://localhost:1",
      RELAY_SECRET: "idem-test",
      AUTOMATION_SCHEDULER_INTERVAL_MS: "60000",
      BIVY_WORK_LEASE_MS: String(LEASE_MS),
    },
    stdio: "inherit",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${port}/healthz`)).ok) break; } catch {}
    if (i === 99) throw new Error("Control plane did not start");
    await delay(100);
  }

  const login = await request(port, "POST", "/auth/dev-login", undefined, { email: "idem-api@example.com" });
  const token = login.body.token as string;
  assert.ok(token);
  const nodeA = (await request(port, "POST", "/nodes/enroll", token, { nodeId: "idem-a", name: "A" })).body.enrollmentToken as string;
  const nodeB = (await request(port, "POST", "/nodes/enroll", token, { nodeId: "idem-b", name: "B" })).body.enrollmentToken as string;
  assert.ok(nodeA && nodeB);

  // 1) Duplicate trigger delivery collapses to one accepted Run.
  const first = await request(port, "POST", "/account/automation-runs", token, { title: "Dedupe me", sourceKey: "trigger:dup:1" });
  const second = await request(port, "POST", "/account/automation-runs", token, { title: "Dedupe me again", sourceKey: "trigger:dup:1" });
  assert.equal(first.status, 201);
  assert.equal(second.body.id, first.body.id, "a duplicate delivery must not create a second Run");

  // 2) Lease loss during execution: reclaim increments the attempt of the SAME
  //    Run, and the stale Machine cannot heartbeat, complete, or fail it.
  const reclaimed = await request(port, "POST", "/account/automation-runs", token, { title: "Reclaim me" });
  const id = reclaimed.body.id as string;
  assert.equal((await request(port, "POST", `/node/work/${id}/claim`, nodeA)).status, 200);
  assert.equal((await request(port, "POST", `/node/work/${id}/running`, nodeA)).status, 200);
  assert.equal((await request(port, "GET", `/account/automation-runs/${id}`, token)).body.attempt, 1);
  // A's attempt stood up a live session before its machine restarted. That id
  // lands in the run's output via a routine evidence report.
  assert.equal((await request(port, "POST", `/node/work/${id}/evidence`, nodeA, { output: { sessionId: "live-sess-A" } })).status, 200);

  await delay(LEASE_MS + 300); // let A's lease expire (as a machine restart would)
  const bClaim = await request(port, "POST", `/node/work/${id}/claim`, nodeB);
  assert.equal(bClaim.status, 200, "B reclaims the expired lease");
  assert.equal(bClaim.body.item.attempt, 2, "a reclaim is another attempt of the same Run");
  // Resume, don't restart: a reclaim after the machine restarted must CONTINUE
  // the session A already started, not cold-start a new one.
  assert.equal(bClaim.body.item.targetKind, "existing_session", "a reclaimed run with a live session resumes it");
  assert.equal(bClaim.body.item.targetSessionId, "live-sess-A", "the reclaimed run targets the session the prior attempt started");

  assert.equal((await request(port, "POST", `/node/work/${id}/heartbeat`, nodeA)).status, 409, "the stale Machine cannot renew a reclaimed lease");
  assert.equal((await request(port, "POST", `/node/work/${id}/complete`, nodeA)).status, 409, "the stale Machine cannot complete the new attempt");
  assert.equal((await request(port, "POST", `/node/work/${id}/fail`, nodeA)).status, 409, "the stale Machine cannot fail the new attempt");
  assert.equal((await request(port, "GET", `/account/automation-runs/${id}`, token)).body.status, "claimed", "the Run stays on B's attempt");

  const bComplete = await request(port, "POST", `/node/work/${id}/complete`, nodeB);
  assert.equal(bComplete.status, 200, "the current owner completes");
  assert.equal((await request(port, "GET", `/account/automation-runs/${id}`, token)).body.status, "succeeded");

  // A late completion from the stale Machine after a terminal outcome is still a
  // conflict — the outcome is immutable.
  assert.equal((await request(port, "POST", `/node/work/${id}/complete`, nodeA)).status, 409);

  // 3) Cancellation beats a completion racing behind it, and the losing
  //    completion emits NO succeeded metric (no double-counted outcome).
  const before = await scrape(port);
  const succeededBefore = metric(before, "bivy_run_lifecycle_results_total", "succeeded");
  const cancelledBefore = metric(before, "bivy_run_lifecycle_results_total", "cancelled");

  const raced = await request(port, "POST", "/account/automation-runs", token, { title: "Cancel then complete" });
  const rid = raced.body.id as string;
  assert.equal((await request(port, "POST", `/node/work/${rid}/claim`, nodeA)).status, 200);
  assert.equal((await request(port, "POST", `/node/work/${rid}/running`, nodeA)).status, 200);
  assert.equal((await request(port, "POST", `/account/automation-runs/${rid}/cancel`, token)).status, 200);
  const lateComplete = await request(port, "POST", `/node/work/${rid}/complete`, nodeA);
  assert.equal(lateComplete.status, 409, "completing a cancelled Run is a conflict");
  assert.equal((await request(port, "GET", `/account/automation-runs/${rid}`, token)).body.status, "cancelled", "cancellation wins the race");

  const after = await scrape(port);
  assert.equal(metric(after, "bivy_run_lifecycle_results_total", "succeeded"), succeededBefore, "a blocked completion must not record a succeeded outcome");
  assert.equal(metric(after, "bivy_run_lifecycle_results_total", "cancelled"), cancelledBefore + 1, "exactly one cancellation is counted");

  // 4) A durable failure records a fixed, low-cardinality failure-stage metric.
  const stageBefore = stageMetric(await scrape(port), "agent");
  const failing = await request(port, "POST", "/account/automation-runs", token, { title: "Will fail" });
  const fid = failing.body.id as string;
  assert.equal((await request(port, "POST", `/node/work/${fid}/claim`, nodeA)).status, 200);
  assert.equal((await request(port, "POST", `/node/work/${fid}/running`, nodeA)).status, 200);
  assert.equal((await request(port, "POST", `/node/work/${fid}/fail`, nodeA)).status, 200);
  assert.equal(stageMetric(await scrape(port), "agent"), stageBefore + 1, "a plain agent failure records the agent stage");

  console.log("✓ duplicate-delivery dedupe, reclaim attempt numbering, stale-Machine blocking, cancel/complete race integrity, and failure-stage metric");
} finally {
  proc?.kill("SIGTERM");
}
