// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Unit tests for the central GitHub App: env config parsing, the identity-mode
// resolution table, installation binding storage (via the real pg-mem-backed
// PostgresStore), installation webhook routing, and — the load-bearing property
// — cross-account isolation of the mint path (account A can never mint a token
// for account B's installation).
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createPgMemStore } from "../src/pg-mem-store.js";
import {
  applyCentralInstallationEvent,
  centralGithubAppConfig,
  centralInstallUrl,
  pickCentralInstallation,
  resolveGithubIdentity,
} from "../src/central-github-app.js";
import { mintHostedInstallationToken } from "../src/ephemeral-provisioner.js";
import type { CentralGithubInstallation } from "../src/store.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

async function makeStore() {
  const store = createPgMemStore();
  await store.init();
  return store;
}

function installation(overrides: Partial<CentralGithubInstallation>): CentralGithubInstallation {
  return {
    installationId: "42",
    accountId: "acct",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── env config ──────────────────────────────────────────────────────────────

await test("central config: absent env = cleanly off", () => {
  assert.equal(centralGithubAppConfig({}), null);
  assert.equal(centralGithubAppConfig({ BIVY_CENTRAL_GITHUB_APP_ID: "1" }), null);
  assert.equal(centralGithubAppConfig({ BIVY_CENTRAL_GITHUB_APP_PRIVATE_KEY: pem }), null);
});

await test("central config: accepts raw PEM, escaped-newline PEM, and base64 PEM", () => {
  const base = { BIVY_CENTRAL_GITHUB_APP_ID: "555", BIVY_CENTRAL_GITHUB_APP_SLUG: "bivy-app" };
  const raw = centralGithubAppConfig({ ...base, BIVY_CENTRAL_GITHUB_APP_PRIVATE_KEY: pem });
  assert.equal(raw?.appId, "555");
  assert.equal(raw?.privateKeyPem.trim(), pem.trim());
  const escaped = centralGithubAppConfig({ ...base, BIVY_CENTRAL_GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n") });
  assert.ok(escaped?.privateKeyPem.includes("\n-----END"));
  const b64 = centralGithubAppConfig({ ...base, BIVY_CENTRAL_GITHUB_APP_PRIVATE_KEY: Buffer.from(pem).toString("base64") });
  assert.equal(b64?.privateKeyPem.trim(), pem.trim());
  const garbage = centralGithubAppConfig({ ...base, BIVY_CENTRAL_GITHUB_APP_PRIVATE_KEY: "not-a-key" });
  assert.equal(garbage, null);
  assert.match(centralInstallUrl(raw!, "s3cret")!, /apps\/bivy-app\/installations\/new\?state=s3cret/);
});

// ── identity resolution table ───────────────────────────────────────────────

const central = { appId: "555", privateKeyPem: pem };
const ownApp = { appId: "111", installationId: "9", privateKeyPem: pem };

await test("resolution: explicit mode resolves through its row only", () => {
  const installs = [installation({ installationId: "42", githubAccount: "acme" })];
  const centralPick = resolveGithubIdentity({ hosted: { githubIdentity: "central-app", githubApp: ownApp, githubToken: "pat" }, central, centralInstallations: installs });
  assert.deepEqual(centralPick, { mode: "central-app", kind: "app", appId: "555", installationId: "42", privateKeyPem: pem });
  const own = resolveGithubIdentity({ hosted: { githubIdentity: "own-app", githubApp: ownApp, githubToken: "pat" }, central, centralInstallations: installs });
  assert.equal(own?.mode, "own-app");
  assert.equal((own as { installationId?: string }).installationId, "9");
  const token = resolveGithubIdentity({ hosted: { githubIdentity: "token", githubApp: ownApp, githubToken: "pat" }, central, centralInstallations: installs });
  assert.deepEqual(token, { mode: "token", kind: "token", token: "pat" });
  // A misconfigured explicit choice yields null — never a silent other identity.
  assert.equal(resolveGithubIdentity({ hosted: { githubIdentity: "central-app", githubToken: "pat" }, central: null, centralInstallations: [] }), null);
  assert.equal(resolveGithubIdentity({ hosted: { githubIdentity: "central-app", githubToken: "pat" }, central, centralInstallations: [] }), null);
  assert.equal(resolveGithubIdentity({ hosted: { githubIdentity: "own-app", githubToken: "pat" }, central, centralInstallations: installs }), null);
});

await test("resolution: unset mode keeps the legacy order (own app, PAT) before the central app", () => {
  const installs = [installation({})];
  const own = resolveGithubIdentity({ hosted: { githubApp: ownApp, githubToken: "pat" }, central, centralInstallations: installs });
  assert.equal(own?.mode, "own-app");
  const pat = resolveGithubIdentity({ hosted: { githubToken: "pat" }, central, centralInstallations: installs });
  assert.equal(pat?.mode, "token");
  const fallback = resolveGithubIdentity({ hosted: {}, central, centralInstallations: installs });
  assert.equal(fallback?.mode, "central-app");
  assert.equal(resolveGithubIdentity({ hosted: {}, central: null, centralInstallations: installs }), null);
});

await test("resolution: repo owner picks the matching installation", () => {
  const installs = [
    installation({ installationId: "1", githubAccount: "acme", createdAt: "2026-01-02T00:00:00.000Z" }),
    installation({ installationId: "2", githubAccount: "widgets", createdAt: "2026-01-03T00:00:00.000Z" }),
  ];
  assert.equal(pickCentralInstallation(installs, "Widgets/rocket")?.installationId, "2");
  assert.equal(pickCentralInstallation(installs, "acme/rocket")?.installationId, "1");
  // Unknown owner / no repo: earliest bound installation, deterministically.
  assert.equal(pickCentralInstallation(installs, "other/rocket")?.installationId, "1");
  assert.equal(pickCentralInstallation(installs)?.installationId, "1");
  assert.equal(pickCentralInstallation([]), undefined);
});

// ── installation store + webhook routing ────────────────────────────────────

await test("store: bindings are account-scoped; cross-account delete is refused", async () => {
  const store = await makeStore();
  const a = await store.findOrCreateAccount("a@example.com");
  const b = await store.findOrCreateAccount("b@example.com");
  await store.putCentralGithubInstallation({ installationId: "42", accountId: a.id, githubAccount: "acme" });
  await store.putCentralGithubInstallation({ installationId: "77", accountId: b.id, githubAccount: "widgets" });
  assert.deepEqual((await store.listCentralGithubInstallations(a.id)).map((i) => i.installationId), ["42"]);
  assert.deepEqual((await store.listCentralGithubInstallations(b.id)).map((i) => i.installationId), ["77"]);
  // B cannot unlink A's installation via the account-scoped delete…
  assert.equal(await store.deleteCentralGithubInstallation("42", b.id), false);
  assert.equal((await store.getCentralGithubInstallation("42"))?.accountId, a.id);
  // …but the owner (and the signed uninstall webhook, which omits accountId) can.
  assert.equal(await store.deleteCentralGithubInstallation("42", a.id), true);
  assert.equal(await store.getCentralGithubInstallation("42"), undefined);
});

await test("store: install states are single-use and bound to the initiating account", async () => {
  const store = await makeStore();
  const a = await store.findOrCreateAccount("a@example.com");
  const state = await store.createCentralInstallState(a.id, "/settings");
  assert.deepEqual(await store.consumeCentralInstallState(state), { accountId: a.id, returnPath: "/settings" });
  assert.equal(await store.consumeCentralInstallState(state), undefined);
  assert.equal(await store.consumeCentralInstallState("forged"), undefined);
});

await test("webhook routing: lifecycle events touch only already-bound installations", async () => {
  const store = await makeStore();
  const a = await store.findOrCreateAccount("a@example.com");
  await store.putCentralGithubInstallation({ installationId: "42", accountId: a.id, githubAccount: "acme" });

  // installation.created for an unbound id carries no proof of the Bivy account
  // — it must NOT create a binding.
  const created = await applyCentralInstallationEvent(store, "installation", {
    action: "created",
    installation: { id: 99, account: { login: "victim" } },
    sender: { id: 700, login: "installer" },
  });
  assert.deepEqual(created, { handled: true, action: "unbound" });
  assert.equal(await store.getCentralGithubInstallation("99"), undefined);
  assert.equal(await store.getCentralGithubInstallerAttestation("99"), "700");

  // repo-selection changes update the bound record's metadata.
  const updated = await applyCentralInstallationEvent(store, "installation_repositories", {
    action: "added",
    installation: { id: 42, account: { login: "acme", type: "Organization" }, repository_selection: "selected" },
  });
  assert.equal(updated.action, "updated");
  assert.equal((await store.getCentralGithubInstallation("42"))?.repositorySelection, "selected");

  // uninstall on GitHub unbinds.
  const removed = await applyCentralInstallationEvent(store, "installation", {
    action: "deleted",
    installation: { id: 42 },
  });
  assert.deepEqual(removed, { handled: true, action: "removed", accountId: a.id });
  assert.equal(await store.getCentralGithubInstallation("42"), undefined);

  // non-lifecycle events are left for the enqueue pipeline.
  assert.deepEqual(await applyCentralInstallationEvent(store, "issues", { installation: { id: 42 } }), { handled: false });
});

// ── mint path isolation ─────────────────────────────────────────────────────

process.env.BIVY_CENTRAL_GITHUB_APP_ID = "555";
process.env.BIVY_CENTRAL_GITHUB_APP_PRIVATE_KEY = pem;

const fakeGithub = (log: Array<{ url: string; body?: unknown }>) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const entry = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    log.push(entry);
    if (entry.url.includes("access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_minted", expires_at: "2027-01-01T00:00:00Z" }), { status: 201 });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  }) as typeof fetch;

await test("mint: account A can never mint for B's installation", async () => {
  const store = await makeStore();
  const a = await store.findOrCreateAccount("a@example.com");
  const b = await store.findOrCreateAccount("b@example.com");
  await store.setHostedProvisioning(a.id, { enabled: true });
  await store.setHostedProvisioning(b.id, { enabled: true });
  // Only B has a central installation bound.
  await store.putCentralGithubInstallation({ installationId: "42", accountId: b.id, githubAccount: "acme" });

  const calls: Array<{ url: string; body?: unknown }> = [];
  // A resolves to no identity at all — nothing is minted, no API call is made.
  assert.equal(await mintHostedInstallationToken(store, a.id, { fetchImpl: fakeGithub(calls) }), null);
  assert.equal(calls.length, 0);
  // B mints against its own installation.
  const minted = await mintHostedInstallationToken(store, b.id, { fetchImpl: fakeGithub(calls) });
  assert.equal(minted?.token, "ghs_minted");
  assert.match(calls[0]!.url, /\/app\/installations\/42\/access_tokens$/);
});

await test("mint: central tokens are scoped to the session repo, with unscoped fallback", async () => {
  const store = await makeStore();
  const a = await store.findOrCreateAccount("a@example.com");
  await store.setHostedProvisioning(a.id, { enabled: true });
  await store.putCentralGithubInstallation({ installationId: "42", accountId: a.id, githubAccount: "acme" });

  const calls: Array<{ url: string; body?: unknown }> = [];
  const minted = await mintHostedInstallationToken(store, a.id, { repo: "acme/rocket", fetchImpl: fakeGithub(calls) });
  assert.equal(minted?.token, "ghs_minted");
  assert.deepEqual(calls[0]!.body, { repositories: ["rocket"] });

  // GitHub refusing the scope (repo outside the installation) falls back to the
  // full-installation token rather than failing the git op.
  const rejectScoped = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) return new Response(JSON.stringify({ message: "unknown repo" }), { status: 422 });
    return new Response(JSON.stringify({ token: "ghs_unscoped", expires_at: "2027-01-01T00:00:00Z" }), { status: 201 });
  }) as typeof fetch;
  const fallback = await mintHostedInstallationToken(store, a.id, { repo: "acme/other", fetchImpl: rejectScoped });
  assert.equal(fallback?.token, "ghs_unscoped");
});

await test("mint: disabled hosted provisioning and PAT identities mint nothing", async () => {
  const store = await makeStore();
  const a = await store.findOrCreateAccount("a@example.com");
  await store.putCentralGithubInstallation({ installationId: "42", accountId: a.id });
  // hosted provisioning off → no mint even with a bound installation.
  assert.equal(await mintHostedInstallationToken(store, a.id, { fetchImpl: fakeGithub([]) }), null);
  // explicit token identity → injected at launch, never minted here.
  await store.setHostedProvisioning(a.id, { enabled: true, githubIdentity: "token" });
  assert.equal(await mintHostedInstallationToken(store, a.id, { fetchImpl: fakeGithub([]) }), null);
});

console.log(`central-github-app: ${passed} tests passed`);
