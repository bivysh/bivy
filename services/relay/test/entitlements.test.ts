// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import { WebSocket } from "ws";

/**
 * Entitlement-gate test for the relay.
 *
 * Launch policy gives Free accounts one hosted-relay node. This covers the
 * entitlement enforcement path with ENFORCE_ENTITLEMENTS=1 so a fresh free
 * account can connect to the relay, and the dev billing webhook can still move
 * the account to Individual without breaking relay access.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cpDir = path.resolve(testDir, "../../control-plane");
const relayDir = path.resolve(testDir, "..");

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

const CP_PORT = await freePort();
const RELAY_PORT = await freePort();
const SECRET = "test-relay-secret-entitlements";

const procs: ChildProcess[] = [];
function spawnService(cwd: string, env: Record<string, string>) {
  const child = spawn("npx", ["tsx", "src/index.ts"], { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
  child.once("error", (error) => {
    console.error(`Failed to start service in ${cwd}:`, error);
    cleanup(1);
  });
  procs.push(child);
  return child;
}

function cleanup(code: number) {
  for (const p of procs) p.kill("SIGTERM");
  process.exit(code);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function http(pathname: string, body: unknown, token?: string) {
  const res = await fetch(`http://localhost:${CP_PORT}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function connectAndWaitForReady(url: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let ready = false;
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.t === "ready") {
        ready = true;
        ws.close();
      }
    });
    ws.once("close", () => resolve(ready));
    ws.once("error", () => resolve(ready));
    setTimeout(() => {
      ws.close();
      resolve(ready);
    }, timeoutMs);
  });
}

function expect(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    cleanup(1);
  }
  console.log(`✓ ${msg}`);
}

async function main() {
  spawnService(cpDir, { PORT: String(CP_PORT), RELAY_SECRET: SECRET });
  spawnService(relayDir, {
    PORT: String(RELAY_PORT),
    RELAY_SECRET: SECRET,
    CONTROL_PLANE_URL: `http://localhost:${CP_PORT}`,
    ENFORCE_ENTITLEMENTS: "1",
  });
  await waitForHttp(`http://localhost:${CP_PORT}/healthz`);
  await waitForHttp(`http://localhost:${RELAY_PORT}/healthz`);

  // A brand-new account defaults to the free plan and is allowed one relay node.
  const login = await http("/auth/dev-login", { email: "free-plan@example.com" });
  const accountId = login.json.account.id;
  const sessionToken = login.json.token;
  expect(login.json.account.plan === "free", "fresh account defaults to the free plan");

  const enroll = await http("/nodes/enroll", { nodeId: "node_free_1", name: "Free node" }, sessionToken);
  const enrollmentToken = enroll.json.enrollmentToken;
  expect(!!enrollmentToken, "node enrolled on the free plan");

  // Node connect is allowed even with ENFORCE_ENTITLEMENTS=1 because Free now
  // includes one hosted relay node.
  const nodeTicket = (await http("/node/relay-ticket", {}, enrollmentToken)).json.ticket;
  const readyFreeNode = await connectAndWaitForReady(`ws://localhost:${RELAY_PORT}/node?ticket=${nodeTicket}`);
  expect(readyFreeNode, "free-plan node is allowed onto the relay");

  // Upgrade the account (dev-mode billing webhook fallback, no live Stripe
  // needed) and confirm relay access still works.
  const webhook = await http("/billing/webhook", { accountId, plan: "pro" });
  expect(webhook.json?.received === true, "dev billing webhook applied the plan upgrade");

  const nodeTicket2 = (await http("/node/relay-ticket", {}, enrollmentToken)).json.ticket;
  const readyAfterUpgrade = await connectAndWaitForReady(`ws://localhost:${RELAY_PORT}/node?ticket=${nodeTicket2}`);
  expect(readyAfterUpgrade, "node on the pro plan is allowed onto the relay");

  console.log("\nAll relay entitlement checks passed.");
  cleanup(0);
}

main().catch((error) => {
  console.error(error);
  cleanup(1);
});
