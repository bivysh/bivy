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
  const port = await startControlPlane({ HOSTED_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64") });

  // Unauthenticated read is refused.
  const anonRead = await req(port, "GET", "/account/ephemeral-configs", undefined);
  expect(anonRead.status === 401, `unauthenticated GET is refused (got ${anonRead.status})`);

  const login = await req(port, "POST", "/auth/dev-login", { email: "cfg@example.com" });
  const token = login.json.token;
  expect(Boolean(token), "dev-login returns a token");

  const claim = await req(port, "POST", "/account/node-claims", undefined, token);
  expect(claim.status === 201 && typeof claim.json?.command === "string", "signed-in account creates a one-time machine command");
  const claimUrl = new URL(claim.json.claimUrl);
  const scriptResponse = await fetch(`http://localhost:${port}${claimUrl.pathname}`);
  const script = await scriptResponse.text();
  expect(scriptResponse.status === 200 && script.includes("BIVY_NODE_CLAIM_CODE") && script.includes("bivy.sh/install.sh"), "claim URL serves the enrollment bootstrap");
  const code = claimUrl.pathname.split("/").at(-1)!;
  const claimed = await req(port, "POST", `/claim/${code}/enroll`, { nodeId: "claimed-machine", name: "Claimed machine" });
  expect(claimed.status === 200 && typeof claimed.json?.enrollmentToken === "string", "claim atomically enrolls one machine without a user session");
  const replay = await req(port, "POST", `/claim/${code}/enroll`, { nodeId: "claim-replay", name: "Replay" });
  expect(replay.status === 410, "used machine claim rejects replay");
  const claims = await req(port, "GET", "/account/node-claims", undefined, token);
  expect(claims.json?.[0]?.status === "used" && claims.json?.[0]?.nodeId === "claimed-machine", "claim status records only the enrolled node identity");
  expect(!JSON.stringify(claims.json).includes(code), "raw machine claim is never returned after creation");
  const authRunnerOff = await req(port, "POST", "/account/onboarding/auth-runner", undefined, token);
  expect(authRunnerOff.status === 503, "managed authentication Machine fails closed when the operator lane is disabled");

  // Fresh account: no configs, shared-queue routing.
  const empty = await req(port, "GET", "/account/ephemeral-configs", undefined, token);
  expect(empty.status === 200 && Array.isArray(empty.json) && empty.json.length === 0, "fresh account has no configs");
  const routing0 = await req(port, "GET", "/account/queue-routing", undefined, token);
  expect(routing0.json?.primary?.kind === "shared", "fresh account routes to the shared queue");

  // Create a config; ttl below the floor clamps to 5.
  const created = await req(port, "POST", "/account/ephemeral-configs", { name: "fly-small-iad", provider: "fly", region: "iad", size: "shared-1x", image: "ghcr.io/bivysh/bivy-ephemeral-runner:sha-test", ttlMinutes: 1, readyCapacity: 9, teardownOnAgentFinish: true }, token);
  expect(created.status === 200 && typeof created.json?.id === "string" && created.json.id.startsWith("cfg-"), "create returns a config with a cfg- id");
  expect(created.json?.ttlMinutes === 15, `ready capacity raises ttlMinutes 1 → 15 so it has claimable life (got ${created.json?.ttlMinutes})`);
  expect(created.json?.provider === "fly" && created.json?.teardownOnAgentFinish === true, "create keeps provider + teardown");
  expect(created.json?.image === "ghcr.io/bivysh/bivy-ephemeral-runner:sha-test", "create keeps curated runner image");
  expect(created.json?.readyCapacity === 1, "create caps ready capacity at one runner");
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

  // Stored is not the same as validated: unattended launch remains blocked until
  // the read-only provider check binds this exact token fingerprint.
  const plan2 = await req(port, "POST", "/account/hosted-provision-now", {}, token);
  expect(plan2.json?.plan?.willProvision === false && /has not been validated/.test(plan2.json?.plan?.reason), "plan: stored but unvalidated provider token → no provision");

  // Audit trail records credential updates and never contains a secret.
  const auditRows = await req(port, "GET", "/account/hosted-audit", undefined, token);
  expect(Array.isArray(auditRows.json) && auditRows.json.some((e: { action: string }) => e.action === "credential_updated"), "audit records credential_updated");
  expect(!/ghp_secret_value|fly_secret_value/.test(JSON.stringify(auditRows.json)), "audit never contains secrets");

  // Hosted machine inventory is authenticated, empty initially, and a manual
  // teardown of an unknown node is an explicit 404 (never a false success).
  expect((await req(port, "GET", "/account/hosted-machines", undefined)).status === 401, "hosted machine inventory requires authentication");
  const machines0 = await req(port, "GET", "/account/hosted-machines", undefined, token);
  expect(machines0.status === 200 && Array.isArray(machines0.json) && machines0.json.length === 0, "fresh hosted machine inventory is empty");
  const missingMachine = await req(port, "DELETE", "/account/hosted-machines/eph-missing", undefined, token);
  expect(missingMachine.status === 404, `manual teardown of an unknown hosted machine is 404 (got ${missingMachine.status})`);

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

  // Node primary + fallback still requires the provider credential validation.
  await req(port, "PUT", "/account/queue-routing", { primary: { kind: "node", node: "laptop" }, fallback: { kind: "config", configId: id } }, token);
  const plan4 = await req(port, "POST", "/account/hosted-provision-now", {}, token);
  expect(plan4.json?.plan?.willProvision === false && /has not been validated/.test(plan4.json?.plan?.reason), "plan: node offline + unvalidated fallback token → no provision");

  // A profile turning offline automations off withdraws the server's copy of
  // that provider's credential by sending an empty token; other providers stay.
  await req(port, "PUT", "/account/hosted-provisioning", { providerTokens: { hetzner: "hz_secret_value" } }, token);
  const withdrawn = await req(port, "PUT", "/account/hosted-provisioning", { providerTokens: { fly: "" } }, token);
  expect(withdrawn.status === 200 && !withdrawn.json?.providers?.includes("fly") && withdrawn.json?.providers?.includes("hetzner"), `empty token withdraws only that provider's credential (got ${JSON.stringify(withdrawn.json?.providers)})`);

  // Fail closed: a control plane WITHOUT an encryption key refuses to store secrets.
  const port2 = await startControlPlane();
  const token2 = (await req(port2, "POST", "/auth/dev-login", { email: "nokey@example.com" })).json.token;
  const refused = await req(port2, "PUT", "/account/hosted-provisioning", { providerTokens: { fly: "x" } }, token2);
  expect(refused.status === 503, `no encryption key → secret writes refused (got ${refused.status})`);
  const enableOk = await req(port2, "PUT", "/account/hosted-provisioning", { enabled: true }, token2);
  expect(enableOk.status === 200 && enableOk.json?.encryptionReady === false, "the enable flag alone is still allowed without a key");

  // Existing users who predate managed onboarding receive the deployment-owned
  // profile when their ordinary Machine picker lists configs. Explicit first-run
  // setup remains idempotent, and later reads reconcile a stale image.
  const port3 = await startControlPlane({
    HOSTED_CREDENTIAL_KEY: Buffer.alloc(32, 9).toString("base64"),
    MANAGED_COMPUTE_ENABLED: "1",
    MANAGED_PROVIDER_TOKEN_FLY: "operator-token-not-used-by-default-setup",
    MANAGED_SESSION_IMAGE: "ghcr.io/bivysh/bivy-ephemeral-runner:current-staging-sha",
  });
  const token3 = (await req(port3, "POST", "/auth/dev-login", { email: "managed-default@example.com" })).json.token;
  const adoptedConfigs = await req(port3, "GET", "/account/ephemeral-configs", undefined, token3);
  const adopted = adoptedConfigs.json?.find((config: { computeSource?: string }) => config.computeSource === "managed");
  expect(adoptedConfigs.status === 200 && adopted?.name === "Bivy Cloud", "existing account config listing adopts the managed profile");
  const managedDefault = await req(port3, "POST", "/account/onboarding/managed-defaults", undefined, token3);
  expect(managedDefault.status === 200 && managedDefault.json?.config?.id === adopted.id, "explicit managed onboarding remains idempotent");
  const automationTarget = await req(port3, "POST", "/account/managed-automation-target", undefined, token3);
  const automationTargetAgain = await req(port3, "POST", "/account/managed-automation-target", undefined, token3);
  expect(automationTarget.status === 200 && automationTarget.json?.nodeId?.startsWith("eph-managed-auto-") && typeof automationTarget.json?.roomKey === "string", "managed automations receive a stable E2E target");
  expect(automationTargetAgain.json?.nodeId === automationTarget.json?.nodeId && automationTargetAgain.json?.roomKey === automationTarget.json?.roomKey, "managed automation identity is idempotent");
  await req(port3, "PUT", `/account/ephemeral-configs/${adopted.id}`, { image: "stale-image", ttlMinutes: 999 }, token3);
  const managedConfigs = await req(port3, "GET", "/account/ephemeral-configs", undefined, token3);
  const reconciled = managedConfigs.json?.find((config: { computeSource?: string }) => config.computeSource === "managed");
  expect(managedConfigs.json?.length === 1 && reconciled?.image === "ghcr.io/bivysh/bivy-ephemeral-runner:current-staging-sha" && reconciled?.ttlMinutes === 60, "managed config reads reconcile deployment-owned image and TTL");
  const managedRouting = await req(port3, "GET", "/account/queue-routing", undefined, token3);
  expect(managedRouting.json?.primary?.kind === "shared", "interactive managed setup does not silently enable unattended queue routing");
  const forgedRestore = await req(port3, "POST", "/account/managed-machines/restore", { configId: managedDefault.json.config.id, nodeId: "eph-other", sessionId: "s-other" }, token3);
  expect(forgedRestore.status === 404, "managed restore requires an account-scoped durable session correlation");

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
