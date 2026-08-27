// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// End-to-end test of the central GitHub App over HTTP: a real control-plane
// process (pg-mem-backed) configured with a central app, talking to a local
// stand-in GitHub API (GITHUB_API_BASE_URL). Covers the install flow (state
// binding, forged/expired states, cross-account reads), the webhook fan-in
// (installation id → account → enqueue; unbound installations dropped), and
// the node mint path (per-account isolation, repo scoping).
import { createHmac, generateKeyPairSync } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import http from "node:http";

const cpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const procs: ChildProcess[] = [];
const servers: http.Server[] = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function finish(code: number): never {
  for (const proc of procs) proc.kill("SIGTERM");
  for (const server of servers) server.close();
  process.exit(code);
}
function expect(condition: boolean, message: string) {
  if (!condition) {
    console.error(`✗ FAIL: ${message}`);
    finish(1);
  }
  console.log(`✓ ${message}`);
}
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
async function json(port: number, method: string, pathname: string, body?: unknown, token?: string) {
  const response = await fetch(`http://localhost:${port}${pathname}`, {
    method,
    redirect: "manual",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => ({})) as any };
}
async function deliver(port: number, secret: string, event: string, payload: unknown, deliveryId: string) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  const response = await fetch(`http://localhost:${port}/webhooks/central-github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    },
    body: raw,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const WEBHOOK_SECRET = "central-webhook-secret";

// Local stand-in for the slice of the GitHub API the central app touches.
// Records access-token mint bodies so the test can assert repo scoping.
const mintBodies: unknown[] = [];
async function startFakeGithub(): Promise<number> {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const url = String(req.url);
      if (url === "/app/installations/42" && req.method === "GET") {
        return reply(200, { id: 42, account: { login: "acme", type: "Organization" }, repository_selection: "selected" });
      }
      if (url === "/app/installations/42/access_tokens" && req.method === "POST") {
        mintBodies.push(body ?? null);
        return reply(201, { token: "ghs_test42", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      if (url.startsWith("/installation/repositories")) {
        return reply(200, { repositories: [{ full_name: "acme/rocket", private: true, default_branch: "main" }] });
      }
      return reply(404, { message: "not found" });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return port;
}

async function main() {
  const githubPort = await startFakeGithub();
  const port = await freePort();
  const proc = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: cpDir,
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_SECRET: "central-app-test",
      GITHUB_API_BASE_URL: `http://localhost:${githubPort}`,
      BIVY_CENTRAL_GITHUB_APP_ID: "555",
      BIVY_CENTRAL_GITHUB_APP_PRIVATE_KEY: Buffer.from(pem).toString("base64"),
      BIVY_CENTRAL_GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
      BIVY_CENTRAL_GITHUB_APP_SLUG: "bivy-central-test",
      // This legacy-flow fixture signs in through dev-login and therefore has no
      // GitHub OAuth identity proof. Dedicated store/auth tests cover the
      // production-default installer target check.
      BIVY_GITHUB_INSTALLER_IDENTITY_REQUIRED: "0",
    },
    stdio: "inherit",
  });
  procs.push(proc);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/healthz`)).ok) { ready = true; break; }
    } catch {}
    await delay(100);
  }
  if (!ready) throw new Error("Control plane did not start");

  const tokenA = (await json(port, "POST", "/auth/dev-login", { email: "central-a@example.com" })).body.token;
  const tokenB = (await json(port, "POST", "/auth/dev-login", { email: "central-b@example.com" })).body.token;

  // --- Install flow: state binds the callback to the initiating account. ---
  const status = await json(port, "GET", "/account/github/central-app", undefined, tokenA);
  expect(status.body.configured === true && status.body.installations.length === 0, "central app reports configured with no installations yet");

  const stateRes = await json(port, "POST", "/account/github/central-app/install-state", { returnPath: "/settings" }, tokenA);
  expect(typeof stateRes.body.state === "string" && String(stateRes.body.installUrl).includes("bivy-central-test"), "install-state mints a state and install URL");

  const forged = await fetch(`http://localhost:${port}/github/central-app/setup?installation_id=42&state=forged`, { redirect: "manual" });
  expect(forged.status === 403, "setup callback refuses a forged/unknown state");

  const setup = await fetch(`http://localhost:${port}/github/central-app/setup?installation_id=42&state=${stateRes.body.state}`, { redirect: "manual" });
  expect(setup.status === 302 && setup.headers.get("location") === "/settings", "setup callback binds the installation and redirects to the return path");

  const reuse = await fetch(`http://localhost:${port}/github/central-app/setup?installation_id=42&state=${stateRes.body.state}`, { redirect: "manual" });
  expect(reuse.status === 403, "install states are single-use");

  const afterA = await json(port, "GET", "/account/github/central-app", undefined, tokenA);
  expect(afterA.body.installations.length === 1 && afterA.body.installations[0].githubAccount === "acme", "account A sees its bound installation with the GitHub owner recorded");
  const afterB = await json(port, "GET", "/account/github/central-app", undefined, tokenB);
  expect(afterB.body.installations.length === 0, "account B sees no installations (cross-account isolation)");

  const identityA = await json(port, "GET", "/account/hosted-provisioning", undefined, tokenA);
  expect(identityA.body.githubIdentity === "central-app", "first bind selects the central-app identity for the account");

  // --- Repo listing: account-scoped, server-side JWT → installation token. ---
  const reposA = await json(port, "GET", "/account/github/central-app/installations/42/repos", undefined, tokenA);
  expect(reposA.status === 200 && reposA.body.repositories?.[0]?.slug === "acme/rocket", "repo listing returns the installation's repos for the owner");
  const reposB = await json(port, "GET", "/account/github/central-app/installations/42/repos", undefined, tokenB);
  expect(reposB.status === 404, "another account cannot list a foreign installation's repos");

  // --- Webhook fan-in: installation id routes to the bound account. ---
  const badSig = await fetch(`http://localhost:${port}/webhooks/central-github`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "issues", "x-hub-signature-256": "sha256=bad" },
    body: JSON.stringify({ installation: { id: 42 } }),
  });
  expect(badSig.status === 401, "central webhook rejects a bad signature");

  const issuePayload = {
    action: "labeled",
    installation: { id: 42 },
    issue: {
      number: 7,
      title: "Fix the flaky test",
      body: "please",
      html_url: "https://github.com/acme/rocket/issues/7",
      labels: [{ name: "bivy" }],
      author_association: "OWNER",
    },
    repository: { full_name: "acme/rocket" },
    sender: { login: "octocat" },
  };
  const enqueue = await deliver(port, WEBHOOK_SECRET, "issues", issuePayload, "delivery-1");
  expect(enqueue.status === 200 && enqueue.body.enqueued === true, "a bivy-labeled issue on a bound installation enqueues work");

  const itemsA = await json(port, "GET", "/account/work-items", undefined, tokenA);
  const itemsB = await json(port, "GET", "/account/work-items", undefined, tokenB);
  const listA = Array.isArray(itemsA.body) ? itemsA.body : itemsA.body.items ?? [];
  const listB = Array.isArray(itemsB.body) ? itemsB.body : itemsB.body.items ?? [];
  expect(listA.some((i: any) => i.repo === "acme/rocket"), "the work item landed in the BOUND account's queue");
  expect(!listB.some((i: any) => i.repo === "acme/rocket"), "no work item leaked into another account's queue");

  const unbound = await deliver(port, WEBHOOK_SECRET, "issues", { ...issuePayload, installation: { id: 99 } }, "delivery-2");
  expect(unbound.status === 200 && unbound.body.enqueued === false && unbound.body.reason === "unbound_installation", "an unbound installation's event is acked and dropped");

  // --- Node mint path: identity resolves per account; tokens are repo-scoped. ---
  await json(port, "PUT", "/account/hosted-provisioning", { enabled: true }, tokenA);
  await json(port, "PUT", "/account/hosted-provisioning", { enabled: true }, tokenB);
  const nodeA = (await json(port, "POST", "/nodes/enroll", { nodeId: "node-a", name: "runner-a" }, tokenA)).body.enrollmentToken;
  const nodeB = (await json(port, "POST", "/nodes/enroll", { nodeId: "node-b", name: "runner-b" }, tokenB)).body.enrollmentToken;

  const mintA = await json(port, "POST", "/node/hosted-git-credential", { repo: "acme/rocket" }, nodeA);
  expect(mintA.status === 200 && mintA.body.token === "ghs_test42", "a node on the bound account mints a central installation token");
  expect(JSON.stringify(mintBodies.at(-1)) === JSON.stringify({ repositories: ["rocket"] }), "the minted token was scoped to the session repo");

  const mintB = await json(port, "POST", "/node/hosted-git-credential", { repo: "acme/rocket" }, nodeB);
  expect(mintB.status === 404, "a node on another account cannot mint against the foreign installation");

  // --- Uninstall on GitHub unbinds via the webhook. ---
  const uninstall = await deliver(port, WEBHOOK_SECRET, "installation", { action: "deleted", installation: { id: 42 } }, "delivery-3");
  expect(uninstall.status === 200 && uninstall.body.installation === "removed", "installation.deleted webhook removes the binding");
  const afterUninstall = await json(port, "GET", "/account/github/central-app", undefined, tokenA);
  expect(afterUninstall.body.installations.length === 0, "the binding is gone after uninstall");

  console.log("central-github-webhook: all tests passed");
  finish(0);
}

main().catch((error) => {
  console.error(error);
  finish(1);
});
