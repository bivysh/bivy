#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] ?? "self-host-release");
const version = `v${JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version}`;
if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error("Self-host bundles require a stable release version.");
const sha = execFileSync("git", ["rev-parse", "HEAD^{commit}"], { cwd: root, encoding: "utf8" }).trim();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-self-host-bundle-"));
try {
  // Explicit allowlist: never archive the checkout, .env, backups or build state.
  const files = [
    "LICENSE", "NOTICE", "deploy/README.md", "deploy/Caddyfile",
    "deploy/self-host.sh", "deploy/manage.sh", "deploy/common.sh", "deploy/install.sh",
    "deploy/docker-compose.yml", "deploy/docker-compose.hosted-db.yml",
    "deploy/control-plane.env.example", "deploy/relay.env.example", "docs/deploy-images.md",
    "docs/self-host-quickstart.md", "docs/self-host.md", "docs/github-oauth-setup.md",
  ];
  for (const file of files) {
    const dest = path.join(temp, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, file), dest);
  }
  fs.writeFileSync(path.join(temp, "deploy/RELEASE_IMAGE_TAG"), `${sha}\n`);
  fs.writeFileSync(path.join(temp, "deploy/RELEASE_VERSION"), `${version}\n`);
  files.push("deploy/RELEASE_IMAGE_TAG", "deploy/RELEASE_VERSION");
  fs.mkdirSync(output, { recursive: true });
  const archive = path.join(output, "bivy-self-host.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", temp, ...files]);
  const checksum = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  fs.writeFileSync(`${archive}.sha256`, `${checksum}  bivy-self-host.tar.gz\n`);
  fs.copyFileSync(path.join(temp, "deploy/install.sh"), path.join(output, "install.sh"));
  console.log(`Built self-host bundle ${version} (${sha}) in ${output}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
