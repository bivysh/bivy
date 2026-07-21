#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Generate the Ed25519 keypair used to sign Bivy release manifests.
//
//   node scripts/generate-release-key.mjs [--out-dir <dir>]
//
// Run this OFFLINE, on a machine you trust. The private key signs every release
// tarball manifest; anyone holding it can ship a "valid" Bivy to your users.
//
//   - Private key -> your secret manager (1Password, GitHub Actions secret in
//     the PRIVATE release repo, or an offline vault). Never commit it.
//   - Public key  -> embedded into the served install.sh at build time via
//     BIVY_RELEASE_VERIFY_KEY_PEM / _FILE. Safe to publish.
//
// See docs/release-signing.md.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
let outDir = process.cwd();
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out-dir" || args[i] === "-o") {
    outDir = args[++i];
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log("usage: node scripts/generate-release-key.mjs [--out-dir <dir>]");
    process.exit(0);
  } else {
    console.error(`unknown argument: ${args[i]}`);
    process.exit(2);
  }
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
const pubPem = publicKey.export({ type: "spki", format: "pem" });

fs.mkdirSync(outDir, { recursive: true });
const privPath = path.join(outDir, "bivy-release-ed25519.pem");
const pubPath = path.join(outDir, "bivy-release-ed25519.pub.pem");

if (fs.existsSync(privPath) || fs.existsSync(pubPath)) {
  console.error(`refusing to overwrite existing key files in ${outDir}`);
  console.error("move or delete them first, or pass a different --out-dir");
  process.exit(1);
}

fs.writeFileSync(privPath, privPem, { mode: 0o600 });
fs.writeFileSync(pubPath, pubPem, { mode: 0o644 });

// Sanity check: sign and verify a probe so a broken key never reaches a release.
const probe = Buffer.from("bivy-release-key-selftest");
const sig = crypto.sign(null, probe, privateKey);
if (!crypto.verify(null, probe, publicKey, sig)) {
  console.error("self-test failed: generated key does not verify its own signature");
  process.exit(1);
}

console.log(`Wrote ${privPath} (mode 600) -- PRIVATE, store in a secret manager`);
console.log(`Wrote ${pubPath}            -- public, embed in the installer`);
console.log("");
console.log("Next steps:");
console.log("  1. Store the PRIVATE key as a secret in the private release repo:");
console.log(`       gh secret set BIVY_RELEASE_SIGNING_KEY_PEM --repo bivysh/bivy-cloud < ${privPath}`);
console.log("  2. Commit the PUBLIC key value into the release build environment:");
console.log(`       gh secret set BIVY_RELEASE_VERIFY_KEY_PEM --repo bivysh/bivy-cloud < ${pubPath}`);
console.log("  3. Build a signed release and confirm the installer carries the key:");
console.log(`       BIVY_RELEASE_SIGNING_KEY_FILE=${privPath} \\`);
console.log(`       BIVY_RELEASE_VERIFY_KEY_FILE=${pubPath} \\`);
console.log("         npm run build:release");
console.log("       grep -c BEGIN.PUBLIC.KEY site/install.sh   # must be >= 1");
console.log("  4. Delete the private key from this machine once it is stored safely.");
