#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Point packaging/aur/PKGBUILD at a GitHub release: sets pkgver, resets pkgrel
// and pins each architecture's archive sha256 from the release's SHA256SUMS.
//
//   node scripts/aur-bump.mjs            the version in package.json
//   node scripts/aur-bump.mjs 0.21.0
import fs from "node:fs";

const pkgbuild = new URL("../packaging/aur/PKGBUILD", import.meta.url);
const version = process.argv[2] ?? JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Not a release version: ${version}`);
  process.exit(2);
}
const url = `https://github.com/bivysh/bivy/releases/download/v${version}/SHA256SUMS`;
const res = await fetch(url);
if (!res.ok) {
  console.error(`${url} returned ${res.status}; release ${version} first.`);
  process.exit(1);
}
const sums = await res.text();
/** pacman architecture → archive target. */
const ARCHES = { x86_64: "linux-x64", aarch64: "linux-arm64" };
let text = fs.readFileSync(pkgbuild, "utf8")
  .replace(/^pkgver=.*$/m, `pkgver=${version}`)
  .replace(/^pkgrel=.*$/m, "pkgrel=1");
for (const [arch, target] of Object.entries(ARCHES)) {
  const sha256 = sums.split("\n").find((line) => line.endsWith(`  bivy-${version}-${target}.tar.gz`))?.split(" ")[0];
  if (!sha256) {
    console.error(`${url} lists no ${target} archive.`);
    process.exit(1);
  }
  text = text.replace(new RegExp(`^sha256sums_${arch}=\\(.*\\)$`, "m"), `sha256sums_${arch}=('${sha256}')`);
  console.log(`${arch}: ${sha256}`);
}
fs.writeFileSync(pkgbuild, text);
console.log(`PKGBUILD → ${version}`);
