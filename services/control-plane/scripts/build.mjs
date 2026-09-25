#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Bundle the control plane's entry points into dist/ so production runs plain
// `node` instead of transpiling TypeScript on every boot with tsx.
//
// @bivy/core exports raw TypeScript source, so the linked @bivy/* packages are
// bundled in. Every other dependency stays external and loads from node_modules
// as usual (native modules, lazy @sentry/node, and packages that read their own
// files all keep working).
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const external = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) => !name.startsWith("@bivy/"));

await build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts", "src/operator-login-cli.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external,
  logLevel: "warning",
});
