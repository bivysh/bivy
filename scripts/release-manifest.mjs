// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Curate the repo's package.json into the manifest shipped in the npm release.
//
// A packaged install ships ONLY bin/, dist/, and public/qr.js — no src/, no
// scripts/, no test/, and no dev toolchain (tsx/tsc/eslint/playwright). So we
// ALLOWLIST the handful of scripts that reference only shipped paths and DROP
// devDependencies wholesale, rather than denylisting the known-bad ones (which
// silently ships every script/dep we forget to prune — see issue #7). This is a
// pure function so it can be unit-tested without running the full release build.

/** Scripts meaningful in a packaged install — they invoke only shipped bin/ + dist/. */
export const KEEP_SCRIPTS = ["setup", "bivy", "start", "dev", "relay:setup", "postinstall"];

/** dependencies present only for the monorepo's mobile app; the node doesn't need them. */
export const DROP_DEPENDENCIES = ["expo", "react", "react-native"];

/**
 * Return a curated COPY of `pkg` (input is not mutated) suitable for publishing:
 * only allowlisted scripts survive, runtime entry points point at compiled dist,
 * devDependencies and workspaces are dropped, mobile deps are pruned, and the
 * `private` flag is cleared so the staged dir remains publishable even though the
 * repo root is marked private to block a stray root `npm publish`.
 */
export function curateManifest(pkg, readme) {
  const out = { ...pkg };

  // npm normally infers README.md while publishing, but trusted publishes of
  // the curated staging directory have reached the registry with empty
  // readme/readmeFilename metadata even though the file is in the tarball.
  // Supplying both fields makes the npm package page deterministic. This is
  // staging-only; the repo manifest does not carry a duplicate markdown blob.
  if (typeof readme === "string" && readme.trim()) {
    out.readme = readme;
    out.readmeFilename = "README.md";
  }

  // The staging dir IS the sanctioned publish path; it must not inherit the repo
  // root's `private: true` (which would make `npm publish` refuse it).
  delete out.private;

  // No packages/* workspaces ship (the web PWA is built/served by the control plane).
  delete out.workspaces;

  // A packaged install has no dev toolchain — drop every devDependency.
  delete out.devDependencies;

  // Mobile-only runtime deps from the monorepo.
  out.dependencies = { ...pkg.dependencies };
  for (const dep of DROP_DEPENDENCIES) delete out.dependencies[dep];

  // Allowlist scripts, then repoint the runtime entry points at the compiled dist
  // (the source `dev`/`start` run `tsx src/server.ts`, which does not ship).
  const scripts = {};
  for (const name of KEEP_SCRIPTS) {
    if (pkg.scripts && pkg.scripts[name] !== undefined) scripts[name] = pkg.scripts[name];
  }
  scripts.start = "node dist/server.js";
  scripts.dev = "node dist/server.js";
  out.scripts = scripts;

  return out;
}
