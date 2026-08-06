// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-self-host-test-"));
  fixtures.push(root);
  const deploy = path.join(root, "deploy");
  const fakeBin = path.join(root, "fake-bin");
  fs.mkdirSync(deploy, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "deploy/self-host.sh"), path.join(deploy, "self-host.sh"));
  fs.copyFileSync(path.join(repoRoot, "deploy/Caddyfile"), path.join(deploy, "Caddyfile"));
  const dockerMarker = path.join(root, "docker-was-called");
  fs.writeFileSync(
    path.join(fakeBin, "docker"),
    `#!/usr/bin/env bash\nprintf called > ${JSON.stringify(dockerMarker)}\nexit 97\n`,
    { mode: 0o755 },
  );
  return { root, deploy, dockerMarker, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` } };
}

function run(root: string, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [path.join(root, "deploy/self-host.sh"), "app.test.example", "relay.test.example"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

try {
  const firstFixture = fixture();
  const first = run(firstFixture.root, firstFixture.env);
  assert.equal(first.status, 2, `missing-auth run should stop with exit 2\n${first.stdout}\n${first.stderr}`);
  assert.match(first.stderr, /no\s+production sign-in method is configured/);
  assert.ok(fs.existsSync(path.join(firstFixture.deploy, ".env")), "first run should still write deploy/.env");
  assert.equal(fs.statSync(path.join(firstFixture.deploy, ".env")).mode & 0o777, 0o600, ".env must be private");
  assert.match(fs.readFileSync(path.join(firstFixture.deploy, ".env"), "utf8"), /^AUTH_EMAIL_FROM=$/m);
  assert.equal(fs.existsSync(firstFixture.dockerMarker), false, "auth refusal must happen before Docker");

  const caddyPath = path.join(firstFixture.deploy, "Caddyfile");
  const caddy = fs.readFileSync(caddyPath, "utf8");
  assert.match(caddy, /^app\.test\.example \{/m, "untouched app placeholder should be replaced");
  assert.match(caddy, /^relay\.test\.example \{/m, "untouched relay placeholder should be replaced");
  assert.match(caddy, /@internal path \/metrics\* \/readyz/, "generated Caddyfile must keep internal endpoints private");
  assert.doesNotMatch(caddy, /app\.example\.com|relay\.example\.com/);

  // Empty quoted values and a half-configured GitHub pair are still no auth.
  fs.appendFileSync(
    path.join(firstFixture.deploy, ".env"),
    "\nRESEND_API_KEY=\"\"\nGITHUB_OAUTH_CLIENT_ID=only-an-id\nGITHUB_OAUTH_CLIENT_SECRET=''\n",
  );
  const partial = run(firstFixture.root, firstFixture.env);
  assert.equal(partial.status, 2, "quoted blanks/partial GitHub OAuth must not pass the auth gate");
  assert.equal(fs.existsSync(firstFixture.dockerMarker), false);

  fs.appendFileSync(
    path.join(firstFixture.deploy, ".env"),
    "\nGITHUB_OAUTH_CLIENT_ID=test-client\nGITHUB_OAUTH_CLIENT_SECRET=test-secret\n",
  );
  const configured = run(firstFixture.root, { ...firstFixture.env, BIVY_SELF_HOST_CONFIG_ONLY: "1" });
  assert.equal(configured.status, 0, `configured run should pass the auth gate\n${configured.stdout}\n${configured.stderr}`);
  assert.match(configured.stdout, /auth configuration are valid/);
  assert.equal(fs.existsSync(firstFixture.dockerMarker), false, "config-only mode must not invoke Docker");

  const customized = `${fs.readFileSync(caddyPath, "utf8")}\n# operator customization\n`;
  fs.writeFileSync(caddyPath, customized);
  const rerun = run(firstFixture.root, { ...firstFixture.env, BIVY_SELF_HOST_CONFIG_ONLY: "1" });
  assert.equal(rerun.status, 0);
  assert.equal(fs.readFileSync(caddyPath, "utf8"), customized, "re-runs must preserve a customized Caddyfile");

  // A secret manager can provide auth on the first invocation, avoiding a
  // mandatory edit/re-run while still keeping dev login disabled.
  const injectedFixture = fixture();
  const injected = run(injectedFixture.root, {
    ...injectedFixture.env,
    RESEND_API_KEY: "re_test_value",
    AUTH_EMAIL_FROM: "Bivy <verified@test.example>",
    BIVY_SELF_HOST_CONFIG_ONLY: "1",
  });
  assert.equal(injected.status, 0, `environment-provided auth should work on first run\n${injected.stdout}\n${injected.stderr}`);
  const injectedEnv = fs.readFileSync(path.join(injectedFixture.deploy, ".env"), "utf8");
  assert.match(injectedEnv, /^RESEND_API_KEY=re_test_value$/m);
  assert.match(injectedEnv, /^AUTH_EMAIL_FROM=Bivy <verified@test\.example>$/m);
  assert.match(injectedEnv, /^DISABLE_DEV_LOGIN=1$/m);
  assert.equal(fs.existsSync(injectedFixture.dockerMarker), false);

  // Never overwrite a Caddyfile that differs by even one operator-added line,
  // including before its placeholder domains have been replaced.
  const preCustomizedFixture = fixture();
  const preCustomizedPath = path.join(preCustomizedFixture.deploy, "Caddyfile");
  const preCustomized = `${fs.readFileSync(preCustomizedPath, "utf8")}\n# keep this operator directive\n`;
  fs.writeFileSync(preCustomizedPath, preCustomized);
  const preCustomizedRun = run(preCustomizedFixture.root, {
    ...preCustomizedFixture.env,
    RESEND_API_KEY: "re_test_value",
    AUTH_EMAIL_FROM: "Bivy <verified@test.example>",
    BIVY_SELF_HOST_CONFIG_ONLY: "1",
  });
  assert.equal(preCustomizedRun.status, 0);
  assert.equal(fs.readFileSync(preCustomizedPath, "utf8"), preCustomized);

  // A complete GitHub setup reaches Compose and prints the matching enrollment
  // command rather than an unusable email command.
  const githubFixture = fixture();
  fs.writeFileSync(
    path.join(githubFixture.root, "fake-bin/docker"),
    `#!/usr/bin/env bash\nprintf 'called\\n' >> ${JSON.stringify(githubFixture.dockerMarker)}\nexit 0\n`,
    { mode: 0o755 },
  );
  const githubRun = run(githubFixture.root, {
    ...githubFixture.env,
    GITHUB_OAUTH_CLIENT_ID: "github-client",
    GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
    BIVY_PRUNE: "0",
  });
  assert.equal(githubRun.status, 0, `complete GitHub setup should start\n${githubRun.stdout}\n${githubRun.stderr}`);
  assert.match(githubRun.stdout, /bivy relay:setup .* --github/);
  assert.doesNotMatch(githubRun.stdout, /--email you@example\.com/);
  assert.ok(fs.existsSync(githubFixture.dockerMarker), "configured deployment should invoke Docker");

  console.log("self-host setup: auth gate, first-run auth, Caddy replacement, customization, and enrollment passed");
} finally {
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
}
