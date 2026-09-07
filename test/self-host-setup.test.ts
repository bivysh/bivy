// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures: string[] = [];
function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-self-host-test-"));
  fixtures.push(root);
  const deploy = path.join(root, "deploy");
  const bin = path.join(root, "fake-bin");
  fs.mkdirSync(deploy); fs.mkdirSync(bin);
  for (const name of ["self-host.sh", "common.sh", "manage.sh", "Caddyfile"]) {
    fs.copyFileSync(path.join(repoRoot, "deploy", name), path.join(deploy, name));
  }
  const marker = path.join(root, "calls");
  fs.writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$MARKER"
if [[ "$*" == *' up '* && "\${FAIL_HEALTH:-0}" == 1 ]]; then exit 1; fi
if [[ "$*" == *generateVAPIDKeys* ]]; then echo 'public-key:private-key'; fi
if [[ "$*" == *operator-login-cli.ts* ]]; then echo 'private login link'; fi
if [[ "$*" == *'/auth/owner/status'* ]]; then exit "\${OWNER_PASSWORD_STATUS:-2}"; fi
if [[ "$*" == *pg_dump* ]]; then echo 'database fixture'; fi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "curl"), `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$MARKER"
exit "\${FAIL_HTTPS:-0}"
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, MARKER: marker,
    BIVY_IMAGE_TAG: "test-sha", DATABASE_URL: "", SELF_HOST_OWNER_EMAIL: "owner@self-host.invalid", SELF_HOST_SETUP_TOKEN: "",
    RESEND_API_KEY: "", AUTH_EMAIL_FROM: "", GITHUB_OAUTH_CLIENT_ID: "", GITHUB_OAUTH_CLIENT_SECRET: "",
    BIVY_SELF_HOST_CONFIG_ONLY: "0", ...overrides,
  };
  return {
    root, deploy, marker, env,
    setup: (args = ["app.test.example"], extra: NodeJS.ProcessEnv = {}) => spawnSync("bash", [path.join(deploy, "self-host.sh"), ...args], { cwd: root, encoding: "utf8", env: { ...env, ...extra } }),
    manage: (cmd: string) => spawnSync("bash", [path.join(deploy, "manage.sh"), cmd], { cwd: root, encoding: "utf8", env }),
    config: () => fs.readFileSync(path.join(deploy, ".env"), "utf8"),
    calls: () => fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "",
  };
}
function success(result: ReturnType<typeof spawnSync>) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
try {
  const first = fixture();
  success(first.setup());
  assert.match(first.config(), /^SELF_HOST_OWNER_EMAIL=owner@self-host.invalid$/m);
  assert.match(first.config(), /^DISABLE_DEV_LOGIN=1$/m);
  assert.match(first.config(), /^RELAY_PUBLIC_URL=wss:\/\/app.test.example\/relay$/m);
  assert.match(first.config(), /^POSTGRES_PASSWORD=[A-Za-z0-9_-]+$/m);
  assert.equal(fs.statSync(path.join(first.deploy, ".env")).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(first.deploy, "Caddyfile"), "utf8"), /handle_path \/relay\/\*/);
  assert.match(first.calls(), /--wait --wait-timeout 180/);
  assert.match(first.calls(), /https:\/\/app.test.example\/relay\/healthz/);
  assert.match(first.calls(), /operator-login-cli.ts/);
  assert.match(first.config(), /^WEB_PUSH_VAPID_PUBLIC_KEY=public-key$/m);
  const original = first.config();
  const custom = fs.readFileSync(path.join(first.deploy, "Caddyfile"), "utf8") + "\n# custom\n";
  fs.writeFileSync(path.join(first.deploy, "Caddyfile"), custom);
  fs.writeFileSync(first.marker, "");
  success(first.setup(undefined, { BIVY_IMAGE_TAG: "next-sha" }));
  assert.equal(first.config(), original.replace("BIVY_IMAGE_TAG=test-sha", "BIVY_IMAGE_TAG=next-sha"));
  assert.equal(fs.readFileSync(path.join(first.deploy, "Caddyfile"), "utf8"), custom);
  assert.doesNotMatch(first.calls(), /generateVAPIDKeys/);
  success(first.manage("login"));
  success(first.manage("backup"));
  const backup = fs.readdirSync(path.join(first.root, "backups")).find((f) => f.endsWith(".tar.gz"))!;
  assert.ok(backup);
  assert.equal(fs.statSync(path.join(first.root, "backups", backup)).mode & 0o777, 0o600);
  const members = spawnSync("tar", ["-tzf", path.join(first.root, "backups", backup)], { encoding: "utf8" }).stdout;
  for (const name of ["database.dump", ".env", "Caddyfile", "IMAGE_TAG"]) assert.ok(members.includes(name));

  const two = fixture({ SELF_HOST_OWNER_EMAIL: "", GITHUB_OAUTH_CLIENT_ID: "client", GITHUB_OAUTH_CLIENT_SECRET: "secret" });
  const result = two.setup(["app.test.example", "relay.test.example"]);
  success(result);
  assert.match(result.stdout, /sign in with your configured provider/);
  assert.doesNotMatch(two.calls(), /operator-login-cli.ts/);
  assert.match(two.config(), /^RELAY_PUBLIC_URL=wss:\/\/relay.test.example$/m);
  assert.match(fs.readFileSync(path.join(two.deploy, "Caddyfile"), "utf8"), /^relay.test.example \{/m);

  const browserOwner = fixture({ SELF_HOST_OWNER_EMAIL: "", SELF_HOST_SETUP_TOKEN: "a".repeat(64) });
  const browserResult = browserOwner.setup();
  success(browserResult);
  assert.match(browserResult.stdout, /enter your deployment setup secret/);
  assert.doesNotMatch(browserOwner.calls(), /operator-login-cli/);
  // Browser-only deployments keep working after removing their consumed setup
  // token. Check durable state on a cold start, including managed Postgres.
  for (const databaseUrl of ["", "postgres://user:pass@db.example/bivy?sslmode=require"]) {
    const passwordOwner = fixture({ SELF_HOST_OWNER_EMAIL: "", SELF_HOST_SETUP_TOKEN: "a".repeat(64), DATABASE_URL: databaseUrl });
    success(passwordOwner.setup());
    const configPath = path.join(passwordOwner.deploy, ".env");
    fs.writeFileSync(configPath, passwordOwner.config().replace(/^SELF_HOST_SETUP_TOKEN=.*$/m, "SELF_HOST_SETUP_TOKEN="));
    fs.writeFileSync(passwordOwner.marker, "");
    const resumed = passwordOwner.setup(undefined, { SELF_HOST_SETUP_TOKEN: "", OWNER_PASSWORD_STATUS: "0" });
    success(resumed);
    assert.match(resumed.stdout, /Verified existing owner password/);
    assert.match(resumed.stdout, /sign in with your owner password/);
    const calls = passwordOwner.calls();
    const privateStart = calls.indexOf("up -d --wait --wait-timeout 180 control-plane\n");
    const check = calls.indexOf("/auth/owner/status");
    const publicStart = calls.indexOf("up -d --wait --wait-timeout 180\n");
    assert.ok(privateStart >= 0 && check > privateStart && publicStart > check, "verify the ready control plane before starting the whole stack");
    assert.doesNotMatch(calls, /operator-login-cli/);
    assert.match(passwordOwner.config(), /^SELF_HOST_SETUP_TOKEN=$/m, "do not re-arm setup to permit an upgrade");
    if (databaseUrl) assert.match(calls, /-f deploy\/docker-compose.hosted-db.yml/);

    for (const status of ["1", "2"]) {
      fs.writeFileSync(passwordOwner.marker, "");
      assert.equal(passwordOwner.setup(undefined, { SELF_HOST_SETUP_TOKEN: "", OWNER_PASSWORD_STATUS: status }).status, 2);
      assert.match(passwordOwner.calls(), /\/auth\/owner\/status/);
      assert.doesNotMatch(passwordOwner.calls(), /up -d --wait --wait-timeout 180\n|operator-login-cli/, "absent passwords and failed checks must not start the public stack");
    }
    fs.writeFileSync(passwordOwner.marker, "");
    assert.equal(passwordOwner.setup(undefined, { SELF_HOST_SETUP_TOKEN: "", BIVY_SELF_HOST_CONFIG_ONLY: "1" }).status, 2);
    assert.equal(passwordOwner.calls(), "", "config-only cannot verify a persisted password");
  }
  const weakOwner = fixture({ SELF_HOST_OWNER_EMAIL: "", SELF_HOST_SETUP_TOKEN: "short" });
  assert.equal(weakOwner.setup().status, 1);

  const missing = fixture({ SELF_HOST_OWNER_EMAIL: "" });
  const refusal = missing.setup();
  assert.equal(refusal.status, 2);
  assert.match(refusal.stderr, /no\s+production sign-in method/);
  assert.equal(missing.calls(), "");
  fs.appendFileSync(path.join(missing.deploy, ".env"), "\nRESEND_API_KEY=\"\"\nGITHUB_OAUTH_CLIENT_ID=only-id\nGITHUB_OAUTH_CLIENT_SECRET=''\n");
  assert.equal(missing.setup().status, 2);
  assert.match(missing.calls(), /\/auth\/owner\/status/, "an existing deployment without env auth must check for a persisted password");
  fs.writeFileSync(missing.marker, "");
  fs.appendFileSync(path.join(missing.deploy, ".env"), "\nSELF_HOST_OWNER_EMAIL=owner@self-host.invalid\n");
  success(missing.setup(undefined, { BIVY_SELF_HOST_CONFIG_ONLY: "1" }));
  assert.equal(missing.calls(), "");

  const managed = fixture({ DATABASE_URL: "postgres://user:pass@db.example/bivy?sslmode=require" });
  success(managed.setup());
  assert.match(managed.calls(), /-f deploy\/docker-compose.hosted-db.yml/);
  fs.writeFileSync(managed.marker, "");
  success(managed.setup(undefined, { DATABASE_URL: "" }));
  assert.match(managed.calls(), /-f deploy\/docker-compose.hosted-db.yml/);
  assert.equal(managed.manage("backup").status, 1);

  for (const input of ["bad.example/path", "bad.example:443", "bad.example\nmalicious", "*.example.com", "bad..example", "-bad.example"]) {
    const invalid = fixture();
    assert.equal(invalid.setup([input]).status, 1, input);
    assert.equal(invalid.calls(), "");
    assert.ok(!fs.existsSync(path.join(invalid.deploy, ".env")));
  }
  const beforeMismatch = first.config();
  const mismatch = first.setup(["other.example"], { BIVY_SELF_HOST_CONFIG_ONLY: "1" });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /domains differ/);
  assert.equal(first.config(), beforeMismatch, "invalid domain changes must not change the image pin");
  assert.equal(first.manage("update").status, 1, "source checkouts must not be overwritten by a release bundle");
  fs.writeFileSync(path.join(managed.deploy, "RELEASE_IMAGE_TAG"), "test-sha");
  const update = managed.manage("update");
  assert.equal(update.status, 1);
  assert.match(update.stderr, /BIVY_MANAGED_BACKUP_CONFIRMED/);

  for (const failure of ["FAIL_HEALTH", "FAIL_HTTPS"]) {
    const broken = fixture({ [failure]: "1" });
    const run = broken.setup();
    assert.equal(run.status, 1);
    assert.doesNotMatch(run.stdout, /stack is ready/);
    assert.doesNotMatch(broken.calls(), /operator-login-cli.ts/);
  }
  console.log("self-host: owner/external auth, one/two domains, recovery, backups, managed DB, reruns and readiness failures passed");
} finally {
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
}
