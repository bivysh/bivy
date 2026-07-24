// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  listGitHubApps,
  upsertGitHubApp,
  removeGitHubApp,
  privateKeyIdFor,
  orderAppsForOwner,
  loadGitHubAppConfigs,
} from "../src/github-apps.js";
import { SecretVault } from "../src/secrets.js";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-apps-"));
}

// A syntactically valid PEM fixture is enough: nothing here parses the key.
// (Named FIXTURE_PEM, not PEM, so scripts/secret-scan.mjs's benign-context
// check recognizes it as a test fixture rather than a leaked credential.)
const FIXTURE_PEM = "-----BEGIN RSA PRIVATE KEY-----\nZmFrZQ==\n-----END RSA PRIVATE KEY-----\n";

await check("empty registry lists nothing", () => {
  assert.deepEqual(listGitHubApps(tmpDir(), {}), []);
});

await check("privateKeyIdFor namespaces the vault entry per app", () => {
  assert.equal(privateKeyIdFor("123"), "github.app.123");
  assert.notEqual(privateKeyIdFor("123"), privateKeyIdFor("456"));
});

await check("upsert adds, then updates in place without duplicating", () => {
  const dir = tmpDir();
  upsertGitHubApp(dir, { appId: "1", slug: "one", privateKeyRef: "secret://github.app.1" });
  upsertGitHubApp(dir, { appId: "2", slug: "two", privateKeyRef: "secret://github.app.2" });
  assert.equal(listGitHubApps(dir, {}).length, 2);

  upsertGitHubApp(dir, { appId: "1", owner: "acme", privateKeyRef: "secret://github.app.1" });
  const apps = listGitHubApps(dir, {});
  assert.equal(apps.length, 2, "updating must not append a second row");
  const one = apps.find((a) => a.appId === "1");
  assert.equal(one?.owner, "acme", "new field applied");
  assert.equal(one?.slug, "one", "untouched field preserved");
});

await check("remove drops only the named app", () => {
  const dir = tmpDir();
  upsertGitHubApp(dir, { appId: "1", privateKeyRef: "secret://github.app.1" });
  upsertGitHubApp(dir, { appId: "2", privateKeyRef: "secret://github.app.2" });
  assert.equal(removeGitHubApp(dir, "1"), true);
  assert.deepEqual(
    listGitHubApps(dir, {}).map((a) => a.appId),
    ["2"],
  );
  assert.equal(removeGitHubApp(dir, "nope"), false, "removing an unknown app reports false");
});

// The single-app env configuration (containers, ephemeral runners) must keep
// working, and must not be duplicated when the same app is also in the registry.
await check("env-configured app surfaces as a registry entry", () => {
  const dir = tmpDir();
  const apps = listGitHubApps(dir, { BIVY_GITHUB_APP_ID: "99", BIVY_GITHUB_APP_SLUG: "envapp" });
  assert.equal(apps.length, 1);
  assert.equal(apps[0].appId, "99");
  assert.equal(apps[0].slug, "envapp");
  assert.equal(apps[0].privateKeyRef, "secret://github.app-private-key", "legacy default key id");
});

await check("registry entry wins over the same app in env", () => {
  const dir = tmpDir();
  upsertGitHubApp(dir, { appId: "99", slug: "registry", privateKeyRef: "secret://github.app.99" });
  const apps = listGitHubApps(dir, { BIVY_GITHUB_APP_ID: "99", BIVY_GITHUB_APP_SLUG: "envapp" });
  assert.equal(apps.length, 1, "must not list the same app twice");
  assert.equal(apps[0].slug, "registry");
});

await check("env app is listed alongside a different registry app", () => {
  const dir = tmpDir();
  upsertGitHubApp(dir, { appId: "1", privateKeyRef: "secret://github.app.1" });
  const apps = listGitHubApps(dir, { BIVY_GITHUB_APP_ID: "99" });
  assert.deepEqual(apps.map((a) => a.appId).sort(), ["1", "99"]);
});

await check("loadGitHubAppConfigs resolves keys from the vault", async () => {
  const dir = tmpDir();
  new SecretVault(dir).setLocal(privateKeyIdFor("7"), FIXTURE_PEM, "test key");
  upsertGitHubApp(dir, { appId: "7", slug: "seven", privateKeyRef: `secret://${privateKeyIdFor("7")}` });
  const configs = await loadGitHubAppConfigs(dir, {});
  assert.equal(configs.length, 1);
  assert.equal(configs[0].appId, "7");
  assert.match(configs[0].privateKeyPem, /PRIVATE KEY/);
  assert.equal(configs[0].record.slug, "seven", "the record travels with the config");
});

// One unusable app must not take down the GitHub integration for the others.
await check("an app whose key cannot be resolved is skipped, not fatal", async () => {
  const dir = tmpDir();
  new SecretVault(dir).setLocal(privateKeyIdFor("good"), FIXTURE_PEM, "test key");
  upsertGitHubApp(dir, { appId: "good", privateKeyRef: `secret://${privateKeyIdFor("good")}` });
  upsertGitHubApp(dir, { appId: "broken", privateKeyRef: "secret://github.app.missing" });
  const configs = await loadGitHubAppConfigs(dir, {});
  assert.deepEqual(
    configs.map((c) => c.appId),
    ["good"],
  );
});

await check("a stored value that isn't a PEM is rejected", async () => {
  const dir = tmpDir();
  new SecretVault(dir).setLocal(privateKeyIdFor("8"), "not-a-key", "test");
  upsertGitHubApp(dir, { appId: "8", privateKeyRef: `secret://${privateKeyIdFor("8")}` });
  assert.deepEqual(await loadGitHubAppConfigs(dir, {}), []);
});

// Repo → installation lookup costs one API call per app tried, so the app owned
// by the same account as the repo must be tried first.
await check("orderAppsForOwner puts the owner's own app first", () => {
  const apps = [
    { record: { appId: "1", owner: "personal", privateKeyRef: "x" } },
    { record: { appId: "2", owner: "acme", privateKeyRef: "x" } },
    { record: { appId: "3", owner: "other", privateKeyRef: "x" } },
  ];
  assert.deepEqual(
    orderAppsForOwner(apps, "acme").map((a) => a.record.appId),
    ["2", "1", "3"],
  );
});

await check("orderAppsForOwner is case-insensitive and tolerates unknown owners", () => {
  const apps = [
    { record: { appId: "1", privateKeyRef: "x" } },
    { record: { appId: "2", owner: "AcMe", privateKeyRef: "x" } },
  ];
  assert.equal(orderAppsForOwner(apps, "acme")[0].record.appId, "2");
  assert.equal(orderAppsForOwner(apps, "nobody").length, 2, "no match still returns every app");
});

await check("the registry file is written 0600", () => {
  const dir = tmpDir();
  upsertGitHubApp(dir, { appId: "1", privateKeyRef: "secret://github.app.1" });
  const mode = fs.statSync(path.join(dir, "github-apps.json")).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

await check("a corrupt registry degrades to empty rather than throwing", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "github-apps.json"), "{ not json");
  assert.deepEqual(listGitHubApps(dir, {}), []);
});

if (failures > 0) {
  console.log(`github-apps: ${failures} test(s) failed`);
  process.exit(1);
}
console.log("github-apps: all tests passed");
