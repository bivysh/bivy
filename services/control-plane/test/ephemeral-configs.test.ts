// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

/**
 * Account-level ephemeral node configs + queue routing API. Exercises the real
 * HTTP routes in src/index.ts against the in-memory (pg-mem) store:
 *  - unauthenticated reads are refused,
 *  - a fresh account has no configs and shared-queue routing,
 *  - create/update/delete round-trip and normalize (ttl clamp),
 *  - queue routing normalizes (fallback only kept for a node primary) and persists.
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
    env: { ...process.env, PORT: String(port), RELAY_SECRET: "test-secret-cfg", ...extraEnv },
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

async function waitForHttp(url: string, timeoutMs = 15000) {
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

async function req(port: number, method: string, pathname: string, body: unknown, token?: string) {
  const res = await fetch(`http://localhost:${port}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

function expect(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    cleanup(1);
  }
  console.log(`✓ ${msg}`);
}

async function main() {
  const port = await startControlPlane({ ENFORCE_ENTITLEMENTS: "0", HOSTED_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64") });

  // Unauthenticated read is refused.
  const anonRead = await req(port, "GET", "/account/ephemeral-configs", undefined);
  expect(anonRead.status === 401, `unauthenticated GET is refused (got ${anonRead.status})`);

  const login = await req(port, "POST", "/auth/dev-login", { email: "cfg@example.com" });
  const token = login.json.token;
  expect(Boolean(token), "dev-login returns a token");

  // Fresh account: no configs, shared-queue routing.
  const empty = await req(port, "GET", "/account/ephemeral-configs", undefined, token);
  expect(empty.status === 200 && Array.isArray(empty.json) && empty.json.length === 0, "fresh account has no configs");
  const routing0 = await req(port, "GET", "/account/queue-routing", undefined, token);
  expect(routing0.json?.primary?.kind === "shared", "fresh account routes to the shared queue");

  // Create a config; ttl below the floor clamps to 5.
  const created = await req(port, "POST", "/account/ephemeral-configs", { name: "fly-small-iad", provider: "fly", region: "iad", size: "shared-1x", ttlMinutes: 1, teardownOnAgentFinish: true }, token);
  expect(created.status === 200 && typeof created.json?.id === "string" && created.json.id.startsWith("cfg-"), "create returns a config with a cfg- id");
  expect(created.json?.ttlMinutes === 5, `create clamps ttlMinutes 1 → 5 (got ${created.json?.ttlMinutes})`);
  expect(created.json?.provider === "fly" && created.json?.teardownOnAgentFinish === true, "create keeps provider + teardown");
  const id = created.json.id;

  // Create requires a name.
  const bad = await req(port, "POST", "/account/ephemeral-configs", { provider: "fly" }, token);
  expect(bad.status === 400, `create without a name is rejected (got ${bad.status})`);

  // List reflects the new config.
  const listed = await req(port, "GET", "/account/ephemeral-configs", undefined, token);
  expect(listed.json?.length === 1 && listed.json[0].id === id, "list shows the created config");

  // Update: change size + oversized ttl clamps to 1440.
  const updated = await req(port, "PUT", `/account/ephemeral-configs/${id}`, { size: "shared-2x", ttlMinutes: 5000 }, token);
  expect(updated.json?.size === "shared-2x", "update changes size");
  expect(updated.json?.ttlMinutes === 1440, `update clamps ttlMinutes 5000 → 1440 (got ${updated.json?.ttlMinutes})`);

  // Update of an unknown id is 404.
  const missing = await req(port, "PUT", "/account/ephemeral-configs/cfg-nope", { size: "x" }, token);
  expect(missing.status === 404, `update of unknown id is 404 (got ${missing.status})`);

  // Routing: a config primary keeps no fallback (fallback only valid for a node).
  const rConfig = await req(port, "PUT", "/account/queue-routing", { primary: { kind: "config", configId: id }, fallback: { kind: "config", configId: id } }, token);
  expect(rConfig.json?.primary?.kind === "config" && rConfig.json?.primary?.configId === id, "routing accepts a config primary");
  expect(!rConfig.json?.fallback, "routing drops a fallback on a config primary");

  // Routing: a node primary keeps its config fallback, and it persists.
  const rNode = await req(port, "PUT", "/account/queue-routing", { primary: { kind: "node", node: "laptop" }, fallback: { kind: "config", configId: id } }, token);
  expect(rNode.json?.primary?.kind === "node" && rNode.json?.primary?.node === "laptop", "routing accepts a node primary");
  expect(rNode.json?.fallback?.configId === id, "routing keeps a fallback on a node primary");
  const rAfter = await req(port, "GET", "/account/queue-routing", undefined, token);
  expect(rAfter.json?.primary?.node === "laptop" && rAfter.json?.fallback?.configId === id, "routing persists across requests");

  // --- Hosted (control-plane-orchestrated) provisioning ---
  // Off by default; status is redacted (credential type only, never values).
  const hp0 = await req(port, "GET", "/account/hosted-provisioning", undefined, token);
  expect(hp0.json?.enabled === false && hp0.json?.credential === "none" && Array.isArray(hp0.json?.providers) && hp0.json.providers.length === 0, "hosted provisioning off by default");
  expect(hp0.json?.encryptionReady === true, "encryption key is configured (encryptionReady)");
  expect(hp0.json?.keyId === "default", "active key id reported (single-key → 'default')");

  // Disabled → the plan won't provision.
  const plan0 = await req(port, "POST", "/account/hosted-provision-now", {}, token);
  expect(plan0.json?.plan?.willProvision === false && /disabled/.test(plan0.json?.plan?.reason), "plan: disabled → no provision");

  // Enable + route to the config, but no provider token yet.
  await req(port, "PUT", "/account/hosted-provisioning", { enabled: true }, token);
  await req(port, "PUT", "/account/queue-routing", { primary: { kind: "config", configId: id } }, token);
  const plan1 = await req(port, "POST", "/account/hosted-provision-now", {}, token);
  expect(plan1.json?.plan?.willProvision === false && /no hosted token/.test(plan1.json?.plan?.reason), "plan: config primary, no provider token → no provision");

  // Add credentials (encrypted at rest); verify they are never echoed back.
  const hpSet = await req(port, "PUT", "/account/hosted-provisioning", { githubToken: "ghp_secret_value", providerTokens: { fly: "fly_secret_value" } }, token);
  expect(hpSet.json?.credential === "pat" && hpSet.json?.providers?.includes("fly"), "credentials saved (redacted: pat + fly)");
  expect(!/ghp_secret_value|fly_secret_value/.test(JSON.stringify(hpSet.json)), "PUT never leaks token values");
  const hpGet = await req(port, "GET", "/account/hosted-provisioning", undefined, token);
  expect(!/ghp_secret_value|fly_secret_value/.test(JSON.stringify(hpGet.json)), "GET never leaks token values");

  // The credential round-trips through AES-256-GCM (proves encrypt+decrypt): the
  // plan can now use the provider token to say "ready".
  const plan2 = await req(port, "POST", "/account/hosted-provision-now", {}, token);
  expect(plan2.json?.plan?.willProvision === true && plan2.json?.plan?.targetConfigId === id, "plan: config primary ready → will provision (decrypts token)");

  // Audit trail records credential updates and never contains a secret.
  const auditRows = await req(port, "GET", "/account/hosted-audit", undefined, token);
  expect(Array.isArray(auditRows.json) && auditRows.json.some((e: { action: string }) => e.action === "credential_updated"), "audit records credential_updated");
  expect(!/ghp_secret_value|fly_secret_value/.test(JSON.stringify(auditRows.json)), "audit never contains secrets");

  // Mint-on-demand endpoint: node-authenticated; 404 while no GitHub App is set.
  const enrollTok = (await req(port, "POST", "/nodes/enroll", { nodeId: "eph-mint-t", name: "mint-t" }, token)).json?.enrollmentToken;
  expect(Boolean(enrollTok), "node enrolled for the mint test");
  expect((await req(port, "POST", "/node/hosted-git-credential", undefined)).status === 401, "mint endpoint requires node auth (401)");
  expect((await req(port, "POST", "/node/hosted-git-credential", undefined, enrollTok)).status === 404, "mint endpoint 404 when no GitHub App");

  // Switch to a GitHub App credential (minted tokens preferred over a PAT).
  const hpApp = await req(port, "PUT", "/account/hosted-provisioning", { githubApp: { appId: "123", installationId: "456", privateKeyPem: "-----BEGIN KEY-----\nx\n-----END KEY-----" } }, token);
  expect(hpApp.json?.credential === "app" && hpApp.json?.githubAppId === "123", "credential switches to app when app creds set");

  // Key rotation: re-seal credentials under the current primary key; audited.
  const rot = await req(port, "POST", "/account/hosted-provisioning/rotate", {}, token);
  expect(rot.status === 200 && rot.json?.keyId === "default", "rotate re-seals under the primary key");
  const audit2 = await req(port, "GET", "/account/hosted-audit", undefined, token);
  expect(Array.isArray(audit2.json) && audit2.json.some((e: { action: string }) => e.action === "credential_rotated"), "audit records credential_rotated");

  // Shared routing → nothing to provision.
  await req(port, "PUT", "/account/queue-routing", { primary: { kind: "shared" } }, token);
  const plan3 = await req(port, "POST", "/account/hosted-provision-now", {}, token);
  expect(plan3.json?.plan?.willProvision === false && /does not point at an ephemeral config/.test(plan3.json?.plan?.reason), "plan: shared routing → no provision");

  // Node primary + fallback config, no node online → provisions the fallback.
  await req(port, "PUT", "/account/queue-routing", { primary: { kind: "node", node: "laptop" }, fallback: { kind: "config", configId: id } }, token);
  const plan4 = await req(port, "POST", "/account/hosted-provision-now", {}, token);
  expect(plan4.json?.plan?.willProvision === true && plan4.json?.plan?.targetConfigId === id, "plan: node offline → provision fallback config");

  // Fail closed: a control plane WITHOUT an encryption key refuses to store secrets.
  const port2 = await startControlPlane({ ENFORCE_ENTITLEMENTS: "0" });
  const token2 = (await req(port2, "POST", "/auth/dev-login", { email: "nokey@example.com" })).json.token;
  const refused = await req(port2, "PUT", "/account/hosted-provisioning", { providerTokens: { fly: "x" } }, token2);
  expect(refused.status === 503, `no encryption key → secret writes refused (got ${refused.status})`);
  const enableOk = await req(port2, "PUT", "/account/hosted-provisioning", { enabled: true }, token2);
  expect(enableOk.status === 200 && enableOk.json?.encryptionReady === false, "the enable flag alone is still allowed without a key");

  // Delete removes the config.
  const del = await req(port, "DELETE", `/account/ephemeral-configs/${id}`, undefined, token);
  expect(del.status === 200 && Array.isArray(del.json?.configs) && del.json.configs.length === 0, "delete removes the config");

  console.log("\nAll ephemeral-configs + queue-routing + hosted-provisioning checks passed.");
  cleanup(0);
}

main().catch((error) => {
  console.error(error);
  cleanup(1);
});
