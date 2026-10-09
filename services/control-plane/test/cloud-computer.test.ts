// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { ChildProcess } from "node:child_process";
import { spawnTestService, stopTestServices } from "../../test-service-process.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { createHash } from "node:crypto";

/**
 * The account's cloud computer when the deployment extension runs one sleeping
 * machine per account: the real control plane against a fake extension.
 */

const cpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const procs: ChildProcess[] = [];
const EXTENSION_TOKEN = "test-extension-token";

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

async function waitFor(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function req(port: number, method: string, pathname: string, body: unknown, token?: string) {
  const res = await fetch(`http://localhost:${port}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

function expect(cond: boolean, msg: string) {
  if (!cond) throw new Error(`✗ FAIL: ${msg}`);
  console.log(`✓ ${msg}`);
}

async function main() {
  // Fake extension: one machine per account; records what Core asked for.
  const calls: Array<{ path: string; body: any }> = [];
  let deny = false;
  let acquireDelayMs = 0;
  const extension = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: request.url ?? "", body });
      const nodeId = body.subject?.accountId ? `eph-managed-auto-${createHash("sha256").update(body.subject.accountId).digest("hex").slice(0, 16)}` : "";
      const answers: Record<string, unknown> = {
        "/v1/compute/profile": { profile: { provider: "fly", image: "runner:test", ttlMinutes: 60, accountMachine: true } },
        "/v1/compute/acquire": deny ? { allowed: false, code: "trial_exhausted", reason: "Trial used up." } : { nodeId, state: "launching" },
        "/v1/compute/wake": { state: "waking" },
        "/v1/compute/machines": { machines: [{ id: "fly-1", nodeId, provider: "fly", region: "iad", state: "asleep", createdAt: "2026-10-06T00:00:00Z" }] },
        "/v1/compute/release": { released: true },
        "/v1/policy/check": { allowed: true },
        "/v1/account": { presentation: {} },
      };
      response.setHeader("content-type", "application/json");
      const delay = request.url === "/v1/compute/acquire" ? acquireDelayMs : 0;
      setTimeout(() => response.end(JSON.stringify(answers[request.url ?? ""] ?? {})), delay);
    });
  });
  await new Promise<void>((resolve) => extension.listen(0, "127.0.0.1", resolve));
  extension.unref();
  const port = await freePort();
  procs.push(spawnTestService(cpDir, {
    PORT: String(port),
    RELAY_SECRET: "test-secret-cc",
    HOSTED_CREDENTIAL_KEY: Buffer.alloc(32, 5).toString("base64"),
    EPHEMERAL_MACHINES_ENABLED: "1",
    DEPLOYMENT_EXTENSION_URL: `http://127.0.0.1:${(extension.address() as net.AddressInfo).port}`,
    DEPLOYMENT_EXTENSION_TOKEN: EXTENSION_TOKEN,
  }));
  await waitFor(async () => (await fetch(`http://localhost:${port}/healthz`).catch(() => null))?.ok === true, "control plane");

  const login = await req(port, "POST", "/auth/dev-login", { email: "cloud-computer@example.com" });
  const token = login.json.token;
  const accountId = login.json.account.id;
  const nodeId = `eph-managed-auto-${createHash("sha256").update(accountId).digest("hex").slice(0, 16)}`;

  // Boot payload: only the extension may ask; it re-enrolls the stable node.
  expect((await req(port, "POST", "/internal/compute/bootstrap", { accountId })).status === 401, "the boot payload requires the extension's token");
  const boot = await req(port, "POST", "/internal/compute/bootstrap", { accountId, awakeCapMinutes: 360 }, EXTENSION_TOKEN);
  expect(boot.status === 200 && boot.json?.nodeId === nodeId, "the cloud computer boots as the account's stable node");
  const relay = JSON.parse(Buffer.from(boot.json.files.find((f: { guest_path: string }) => f.guest_path === "/etc/bivy/relay.json").raw_value, "base64").toString("utf8"));
  const start = Buffer.from(boot.json.files.find((f: { guest_path: string }) => f.guest_path === "/etc/bivy/start.sh").raw_value, "base64").toString("utf8");
  expect(typeof relay.enrollmentToken === "string" && relay.enrollmentToken.startsWith("enr_"), "the payload carries a fresh enrollment token");
  expect(/BIVY_EPHEMERAL_SLEEP=1/.test(start) && /BIVY_DATA_DIR=\/data\/bivy/.test(start), "the node sleeps instead of being destroyed, with its state on the volume");
  expect(boot.json.init.exec.includes("21600"), "each awake period is bounded by the awake cap");
  const enrolled = await req(port, "GET", "/nodes", undefined, token);
  expect((enrolled.json ?? []).some((n: { id: string; online: boolean }) => n.id === nodeId && !n.online), "the enrolled node is listed, asleep");

  // Launch returns the cloud computer and the same escrowed key every time.
  const configs = await req(port, "GET", "/account/ephemeral-configs", undefined, token);
  const cloud = configs.json?.find((c: { computeSource?: string }) => c.computeSource === "managed");
  const first = await req(port, "POST", "/account/managed-machines", { configId: cloud.id, runtimeId: "claude-code-sdk", requestId: "r1" }, token);
  const second = await req(port, "POST", "/account/managed-machines", { configId: cloud.id, requestId: "r2" }, token);
  expect(first.status === 201 && first.json?.machine?.nodeId === nodeId && typeof first.json?.roomKey === "string", "launching asks the extension for the account's cloud computer");
  expect(second.json?.roomKey === first.json?.roomKey, "every launch gets the same node key");
  expect(calls.some((c) => c.path === "/v1/compute/acquire" && c.body.purpose === "interactive" && c.body.runtimeId === "claude-code-sdk"), "the extension learns the purpose and agent");
  acquireDelayMs = 6_000;
  const slow = await req(port, "POST", "/account/managed-machines", { configId: cloud.id, requestId: "r-slow" }, token);
  expect(slow.status === 201, "a launch that takes the provider longer than a policy call still succeeds");
  acquireDelayMs = 0;
  deny = true;
  const denied = await req(port, "POST", "/account/managed-machines", { configId: cloud.id, requestId: "r3" }, token);
  expect(denied.status === 403 && denied.json?.code === "trial_exhausted", "a refusal returns the deployment's decision");
  deny = false;

  // Connecting to the sleeping node wakes it.
  const ticket = await req(port, "POST", "/client/relay-ticket", { nodeId }, token);
  expect(ticket.status === 200, "a client can still get a relay ticket for a sleeping node");
  await waitFor(() => calls.some((c) => c.path === "/v1/compute/wake" && c.body.nodeId === nodeId), "wake on connect");
  console.log("✓ connecting to a sleeping cloud computer wakes it");

  // Opening a preview link for it wakes it too (asked by the relay).
  const wakesBefore = calls.filter((c) => c.path === "/v1/compute/wake").length;
  const route = createHash("sha256").update(nodeId).digest("hex").slice(0, 24);
  expect((await req(port, "POST", "/internal/preview-wake", { route })).status === 401, "only the relay may wake a node from a preview");
  const previewWake = await req(port, "POST", "/internal/preview-wake", { route }, "test-secret-cc");
  expect(previewWake.json?.waking === true, "a preview link for a sleeping cloud computer starts it");
  await waitFor(() => calls.filter((c) => c.path === "/v1/compute/wake").length > wakesBefore, "wake on preview");
  const unknown = await req(port, "POST", "/internal/preview-wake", { route: "0".repeat(24) }, "test-secret-cc");
  expect(unknown.json?.waking === false, "a preview for any other node wakes nothing");

  // The node reports this boot's milestones; the launch reads them back.
  const reported = await req(port, "POST", "/node/ephemeral-milestone", { milestone: "credentialsReadyAt" }, relay.enrollmentToken);
  expect(reported.status === 200, "the cloud computer reports its milestones");
  const withMilestones = await req(port, "GET", "/account/hosted-machines", undefined, token);
  expect(typeof withMilestones.json?.[0]?.milestones?.credentialsReadyAt === "string", "the launch sees credentials ready for this boot");
  await req(port, "POST", "/account/managed-machines", { configId: cloud.id, requestId: "r4" }, token);
  const afterStart = await req(port, "GET", "/account/hosted-machines", undefined, token);
  expect(!afterStart.json?.[0]?.milestones?.credentialsReadyAt, "starting the machine again forgets the previous boot's milestones");

  // Inventory and release go through the extension.
  const machines = await req(port, "GET", "/account/hosted-machines", undefined, token);
  expect(machines.json?.[0]?.nodeId === nodeId && machines.json?.[0]?.lifecycleState === "asleep", "the hosted-machines panel shows the extension's machine");
  const released = await req(port, "DELETE", `/account/hosted-machines/${nodeId}`, undefined, token);
  expect(released.status === 200, "release destroys the cloud computer through the extension");

  console.log("\nAll cloud-computer HTTP checks passed.");
}

// Queued work: the routing decision, against the in-memory store.
async function routing() {
  process.env.HOSTED_CREDENTIAL_KEY = Buffer.alloc(32, 5).toString("base64");
  const { createPgMemStore } = await import("../src/pg-mem-store.js");
  const { routeWorkToCloudComputer, cloudComputerNodeId } = await import("../src/cloud-computer.js");
  const store = createPgMemStore();
  await store.init();
  const account = await store.findOrCreateAccount("routing@example.com");
  const cloud = { id: "managed-default", name: "Bivy Cloud", provider: "fly", computeSource: "managed" as const, createdAt: "", updatedAt: "" };
  await store.setEphemeralConfigs(account.id, [cloud]);
  const label = `bivy/${cloudComputerNodeId(account.id).replace(/^eph-/, "")}`;
  const item = await store.enqueueWorkItem(account.id, { source: "manual", title: "nightly" });
  expect(!(await routeWorkToCloudComputer(store, account.id)), "shared routing leaves work for the user's own machines");
  await store.setQueueRouting(account.id, { primary: { kind: "node", node: "laptop" }, fallback: { kind: "config", configId: cloud.id } });
  await store.enrollNode(account.id, "n-laptop", "laptop");
  await store.setNodeOnline("n-laptop", true);
  expect(!(await routeWorkToCloudComputer(store, account.id)), "an online primary machine keeps its work");
  await store.setNodeOnline("n-laptop", false);
  const laptopItem = await store.enqueueWorkItem(account.id, { source: "manual", title: "for laptop", label: "bivy/laptop" });
  expect(await routeWorkToCloudComputer(store, account.id), "an offline primary falls back to the cloud computer");
  const items = await store.listWorkItems(account.id, 10);
  expect(items.find((i) => i.id === laptopItem.id)?.label === label, "the waiting work moves to the cloud computer's label");
  expect(items.find((i) => i.id === item.id)?.label !== label, "work for another route is left alone");
}

try {
  await main();
  await routing();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopTestServices(procs);
}
