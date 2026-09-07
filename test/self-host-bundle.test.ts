// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-bundle-test-"));
const version = `v${JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version}`;
try {
  const assets = path.join(temp, "assets");
  const build = spawnSync(process.execPath, ["scripts/build-self-host.mjs", assets], { cwd: root, encoding: "utf8" });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  const archive = path.join(assets, "bivy-self-host.tar.gz");
  const checksum = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  assert.equal(fs.readFileSync(`${archive}.sha256`, "utf8"), `${checksum}  bivy-self-host.tar.gz\n`);
  const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" }).stdout;
  for (const required of ["deploy/RELEASE_IMAGE_TAG", "deploy/manage.sh", "deploy/common.sh", "LICENSE"]) assert.ok(listing.includes(required));
  assert.doesNotMatch(listing, /(?:^|\/)\.env|node_modules|backups|src\//m);
  const bin = path.join(temp, "bin"); fs.mkdirSync(bin);
  const calls = path.join(temp, "calls");
  const mocks = {
    docker: `printf '%s\\n' "$*" >> "$CALLS"
if [[ "$*" == *generateVAPIDKeys* ]]; then echo 'pub:priv'; fi
if [[ "$*" == *operator-login-cli.ts* ]]; then echo 'single-use login'; fi`,
    getent: "echo '203.0.113.1 STREAM app.test.example'",
    ss: "exit 0",
    curl: `url=""; dest=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output) dest="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ "$url" == */latest ]]; then echo "https://github.com/bivysh/bivy/releases/tag/$TEST_RELEASE_VERSION"; exit 0; fi
if [[ "$url" == */download/* ]]; then
  [[ "\${DOWNLOAD_FAIL:-0}" != 1 ]] || exit 22
  cp "$ASSETS/\${url##*/}" "$dest"
fi`,
  };
  for (const [name, script] of Object.entries(mocks)) fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`, { mode: 0o755 });
  const target = path.join(temp, "installation");
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, ASSETS: assets, CALLS: calls, TEST_RELEASE_VERSION: version,
    BIVY_SELF_HOST_DIR: target, BIVY_SELF_HOST_VERSION: "", BIVY_IMAGE_TAG: "stale-shell-pin",
    DATABASE_URL: "", SELF_HOST_OWNER_EMAIL: "owner@self-host.invalid", SELF_HOST_SETUP_TOKEN: "",
    RESEND_API_KEY: "", AUTH_EMAIL_FROM: "", GITHUB_OAUTH_CLIENT_ID: "", GITHUB_OAUTH_CLIENT_SECRET: "",
    BIVY_SELF_HOST_CONFIG_ONLY: "0",
  };
  const install = (extra = {}) => spawnSync("bash", [path.join(root, "deploy/install.sh"), "app.test.example"], { encoding: "utf8", env: { ...env, ...extra } });
  const installed = install();
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  assert.match(installed.stdout, /stack is ready/);
  const config = fs.readFileSync(path.join(target, "deploy/.env"), "utf8");
  const pin = fs.readFileSync(path.join(target, "deploy/RELEASE_IMAGE_TAG"), "utf8").trim();
  assert.match(pin, /^[a-f0-9]{40}$/);
  assert.ok(config.includes(`BIVY_IMAGE_TAG=${pin}`));
  assert.doesNotMatch(config, /stale-shell-pin/);
  const caddy = path.join(target, "deploy/Caddyfile");
  fs.appendFileSync(caddy, "\n# preserved custom config\n");
  const custom = fs.readFileSync(caddy, "utf8");
  const rerun = install({ BIVY_SELF_HOST_VERSION: version });
  assert.equal(rerun.status, 0, `${rerun.stdout}\n${rerun.stderr}`);
  assert.equal(fs.readFileSync(caddy, "utf8"), custom);
  assert.equal(fs.readFileSync(path.join(target, "deploy/.env"), "utf8"), config);
  for (const extra of [{ DOWNLOAD_FAIL: "1" }, { BIVY_SELF_HOST_VERSION: "../../bad" }]) {
    assert.notEqual(install(extra).status, 0);
    assert.equal(fs.readFileSync(path.join(target, "deploy/.env"), "utf8"), config);
  }
  fs.writeFileSync(`${archive}.sha256`, `${"0".repeat(64)}  bivy-self-host.tar.gz\n`);
  const corrupt = install();
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /checksum mismatch/);
  assert.equal(fs.readFileSync(path.join(target, "deploy/.env"), "utf8"), config);
  console.log("self-host bundle: allowlist/checksum, stable resolution, SHA pin, bootstrap, preservation and download failures passed");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
