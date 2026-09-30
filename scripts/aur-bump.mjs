#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Point packaging/aur/PKGBUILD at an npm release: sets pkgver, resets pkgrel
// and pins the tarball's sha256.
//
//   node scripts/aur-bump.mjs            the version in package.json
//   node scripts/aur-bump.mjs 0.21.0
import { createHash } from "node:crypto";
import fs from "node:fs";

const pkgbuild = new URL("../packaging/aur/PKGBUILD", import.meta.url);
const version = process.argv[2] ?? JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Not a release version: ${version}`);
  process.exit(2);
}
const url = `https://registry.npmjs.org/@bivy/bivy/-/bivy-${version}.tgz`;
const res = await fetch(url);
if (!res.ok) {
  console.error(`${url} returned ${res.status}; publish ${version} to npm first.`);
  process.exit(1);
}
const sha256 = createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
const text = fs.readFileSync(pkgbuild, "utf8")
  .replace(/^pkgver=.*$/m, `pkgver=${version}`)
  .replace(/^pkgrel=.*$/m, "pkgrel=1")
  .replace(/^sha256sums=\(.*\)$/m, `sha256sums=('${sha256}')`);
fs.writeFileSync(pkgbuild, text);
console.log(`PKGBUILD → ${version} (${sha256})`);
