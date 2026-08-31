// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The readiness-led first-run journey's account step is tracked server-side
// (sign_in_completed/sign_in_failed in the FunnelEvent counter), NOT via the
// authenticated per-account product-metrics endpoint — a sign-in FAILURE has,
// by definition, no account yet to attribute an authenticated metric to. Boots
// the real control plane and exercises both a failed and a successful
// magic-link consume against the live /metrics scrape, the same pattern
// run-idempotency.test.ts uses for Run lifecycle counters.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawnTestService, stopTestServices } from "../../test-service-process.js";
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

async function request(port: number, method: string, pathname: string, body?: unknown) {
  const response = await fetch(`http://localhost:${port}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as any };
}

/** Parse a single labelled counter value out of a Prometheus scrape. */
function metric(text: string, event: string, source: string): number {
  const line = text.split("\n").find((l) => l.startsWith(`bivy_funnel_events_total{event="${event}",source="${source}"`));
  return line ? Number(line.trim().split(/\s+/).at(-1)) : 0;
}
async function scrape(port: number): Promise<string> {
  return (await fetch(`http://localhost:${port}/metrics`)).text();
}

let proc: ChildProcess | undefined;
try {
  const port = await freePort();
  proc = spawnTestService(cpDir, {
    PORT: String(port),
    RELAY_PUBLIC_URL: "ws://localhost:1",
    RELAY_SECRET: "sign-in-funnel-test",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${port}/healthz`)).ok) break; } catch {}
    if (i === 99) throw new Error("Control plane did not start");
    await delay(100);
  }

  // A garbage token is exactly what an expired/already-used magic link
  // produces — the real-world failure this metric exists to catch.
  const before = await scrape(port);
  const failedBefore = metric(before, "sign_in_failed", "email_api");
  const failed = await request(port, "POST", "/auth/magic-link/consume", { token: "not-a-real-token" });
  assert.equal(failed.status, 401);
  assert.equal(metric(await scrape(port), "sign_in_failed", "email_api"), failedBefore + 1, "an invalid/expired magic-link token records sign_in_failed");

  // The dev sign-in path is a real successful sign-in (source "dev") — confirm
  // it still lands on sign_in_completed, not sign_in_failed, so the two
  // counters are genuinely disjoint rather than one masking the other.
  const completedBefore = metric(await scrape(port), "sign_in_completed", "dev");
  const login = await request(port, "POST", "/auth/dev-login", { email: "funnel-test@example.com" });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
  assert.equal(metric(await scrape(port), "sign_in_completed", "dev"), completedBefore + 1, "a successful dev sign-in records sign_in_completed");
  assert.equal(metric(await scrape(port), "sign_in_failed", "email_api"), failedBefore + 1, "the successful sign-in did not also bump the failure counter");

  console.log("✓ sign-in funnel: failed magic-link consume and successful dev sign-in record disjoint, low-cardinality counters");
} finally {
  await stopTestServices(proc ? [proc] : []);
}
