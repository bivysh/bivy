// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

/**
 * Push is now included on every plan (`pushEnabled: true` across the board), so
 * push subscription must succeed regardless of regime. Exercised here against the
 * real HTTP routes (the gate lives in the route handlers in src/index.ts):
 *
 *  - ENFORCE_ENTITLEMENTS=1 (Bivy Cloud): a fresh free account may subscribe to
 *    push — the free plan includes it — and a paid plan may too.
 *  - ENFORCE_ENTITLEMENTS unset/0 (self-host / no billing): a fresh free account
 *    MUST be able to subscribe. Regression guard for "push notifications don't work
 *    on self-hosted stacks" even with VAPID keys configured.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cpDir = path.resolve(testDir, "..");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port assigned"))));
    });
    server.on("error", reject);
  });
}

const procs: ChildProcess[] = [];
function cleanup(code: number) {
  for (const p of procs) p.kill("SIGTERM");
  process.exit(code);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startControlPlane(extraEnv: Record<string, string>): Promise<number> {
  const port = await freePort();
  const child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: cpDir,
    env: { ...process.env, PORT: String(port), RELAY_SECRET: "test-secret-push", ...extraEnv },
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error("Failed to start control plane:", error);
    cleanup(1);
  });
  procs.push(child);
  await waitForHttp(`http://localhost:${port}/healthz`);
  return port;
}

async function waitForHttp(url: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch {
      // not ready yet
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function http(port: number, pathname: string, body: unknown, token?: string) {
  const res = await fetch(`http://localhost:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function expect(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    cleanup(1);
  }
  console.log(`✓ ${msg}`);
}

async function main() {
  // --- Regime 1: entitlements enforced (Bivy Cloud) ---
  const enforcedPort = await startControlPlane({ ENFORCE_ENTITLEMENTS: "1" });

  const login = await http(enforcedPort, "/auth/dev-login", { email: "free-push@example.com" });
  const accountId = login.json.account.id;
  const token = login.json.token;

  const freeAccepted = await http(enforcedPort, "/api/push/subscribe", { subscription: { endpoint: "https://push.example/abc" } }, token);
  expect(freeAccepted.status === 200, `enforced: free plan can subscribe to push — it's included (got ${freeAccepted.status})`);

  await http(enforcedPort, "/billing/webhook", { accountId, plan: "pro" });

  const accepted = await http(enforcedPort, "/api/push/subscribe", { subscription: { endpoint: "https://push.example/abc" } }, token);
  expect(accepted.status === 200, `enforced: pro plan can subscribe to push (got ${accepted.status})`);

  // The paid plan id was renamed `individual` -> `pro`. The published CLI sends a
  // plan id over the wire, so a client older than this deploy still says
  // `individual` — it must be translated, not rejected and not silently left free.
  const legacyLogin = await http(enforcedPort, "/auth/dev-login", { email: "legacy-plan@example.com" });
  await http(enforcedPort, "/billing/webhook", { accountId: legacyLogin.json.account.id, plan: "individual" });
  const legacyMe = await fetch(`http://localhost:${enforcedPort}/me`, {
    headers: { authorization: `Bearer ${legacyLogin.json.token}` },
  }).then((r) => r.json());
  expect(legacyMe?.account?.plan === "pro", `legacy "individual" plan id normalizes to "pro" (got ${legacyMe?.account?.plan})`);
  expect(legacyMe?.entitlements?.pushEnabled === true, "legacy-upgraded account receives paid entitlements");

  // --- Regime 2: entitlements NOT enforced (self-host / no billing) ---
  const selfHostPort = await startControlPlane({ ENFORCE_ENTITLEMENTS: "0" });

  const selfHostLogin = await http(selfHostPort, "/auth/dev-login", { email: "selfhost-push@example.com" });
  const selfHostToken = selfHostLogin.json.token;

  const selfHostAccepted = await http(selfHostPort, "/api/push/subscribe", { subscription: { endpoint: "https://push.example/selfhost" } }, selfHostToken);
  expect(selfHostAccepted.status === 200, `self-host: free account can subscribe to push when entitlements are not enforced (got ${selfHostAccepted.status})`);

  console.log("\nAll push entitlement checks passed.");
  cleanup(0);
}

main().catch((error) => {
  console.error(error);
  cleanup(1);
});
