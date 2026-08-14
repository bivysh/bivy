// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  initSharedDepCache,
  depCacheEnv,
  sharedCacheEnvFor,
  __resetSharedDepCacheForTests,
} from "../src/harness/dep-cache.js";

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.BIVY_SHARED_DEP_CACHE;
  if (value === undefined) delete process.env.BIVY_SHARED_DEP_CACHE;
  else process.env.BIVY_SHARED_DEP_CACHE = value;
  __resetSharedDepCacheForTests();
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.BIVY_SHARED_DEP_CACHE;
    else process.env.BIVY_SHARED_DEP_CACHE = prev;
    __resetSharedDepCacheForTests();
  }
}

test("sharedCacheEnvFor maps a root to cache-only knobs under it", () => {
  const root = path.join("/tmp", "cache-root");
  const env = sharedCacheEnvFor(root);
  assert.equal(env.npm_config_cache, path.join(root, "npm"));
  assert.equal(env.PNPM_CONFIG_STORE_DIR, path.join(root, "pnpm"));
  assert.equal(env.YARN_CACHE_FOLDER, path.join(root, "yarn"));
  assert.equal(env.PIP_CACHE_DIR, path.join(root, "pip"));
  assert.equal(env.CARGO_HOME, path.join(root, "cargo"));
  assert.equal(env.GOMODCACHE, path.join(root, "go", "mod"));
  assert.equal(env.GOCACHE, path.join(root, "go", "build"));
  // Every value must live under the shared root (no stray absolute paths).
  for (const v of Object.values(env)) assert.ok(v.startsWith(root), `${v} under ${root}`);
});

test("disabled by default: no flag → empty env, no root", () => {
  withEnv(undefined, () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-depcache-"));
    assert.equal(initSharedDepCache(dataDir), undefined);
    assert.deepEqual(depCacheEnv(), {});
  });
});

test("flag=1 → default location under the data dir, created and reflected in env", () => {
  withEnv("1", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-depcache-"));
    const root = initSharedDepCache(dataDir);
    assert.equal(root, path.join(dataDir, "dep-cache"));
    assert.ok(fs.existsSync(root!), "root directory is created");
    assert.equal(depCacheEnv().npm_config_cache, path.join(dataDir, "dep-cache", "npm"));
  });
});

test("flag=explicit path → used verbatim as the cache root", () => {
  const explicit = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-depcache-explicit-"));
  withEnv(explicit, () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-depcache-"));
    const root = initSharedDepCache(dataDir);
    assert.equal(root, explicit, "explicit path wins over the data-dir default");
    assert.equal(depCacheEnv().CARGO_HOME, path.join(explicit, "cargo"));
  });
});

// pnpm 10+ reads PNPM_CONFIG_STORE_DIR only — not npm_config_store_dir,
// PNPM_STORE_DIR, or an .npmrc `store-dir=` line. Getting this name wrong is
// silent: pnpm just keeps using its own default store.
test("pnpm gets PNPM_CONFIG_STORE_DIR, never the npm_config_ spelling", () => {
  const env = sharedCacheEnvFor(path.join("/tmp", "cache-root"));
  assert.equal(env.npm_config_store_dir, undefined);
  assert.equal(env.PNPM_STORE_DIR, undefined);
});

test("init creates the pnpm store dir up front", () => {
  withEnv("1", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-depcache-"));
    const root = initSharedDepCache(dataDir);
    assert.ok(fs.existsSync(path.join(root!, "pnpm")), "pnpm store exists before any install");
  });
});

// Hardlinks cannot cross filesystems: pointing pnpm at a store on another device
// makes it COPY, costing a full tree per worktree plus a full store. Dropping the
// var leaves pnpm on its own (already per-user global) store instead.
test("pnpm store dir is emitted only for a same-filesystem cwd", () => {
  withEnv("1", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-depcache-"));
    const root = initSharedDepCache(dataDir);
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-worktree-"));
    assert.equal(
      depCacheEnv(worktree).PNPM_CONFIG_STORE_DIR,
      path.join(root!, "pnpm"),
      "same tmpdir filesystem → hardlinks possible",
    );
    // A cwd that does not exist yet resolves through its nearest live ancestor.
    assert.equal(
      depCacheEnv(path.join(worktree, "not-created-yet", "deeper")).PNPM_CONFIG_STORE_DIR,
      path.join(root!, "pnpm"),
    );
    // No cwd → cannot prove linkability → fail closed.
    assert.equal(depCacheEnv().PNPM_CONFIG_STORE_DIR, undefined);
    // Non-pnpm knobs are unaffected by the guard.
    assert.equal(depCacheEnv().npm_config_cache, path.join(root!, "npm"));
  });
});

test("init is idempotent (second call keeps the first root)", () => {
  withEnv("1", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-depcache-"));
    const first = initSharedDepCache(dataDir);
    const second = initSharedDepCache(fs.mkdtempSync(path.join(os.tmpdir(), "bivy-depcache-other-")));
    assert.equal(second, first, "second init does not move the root");
  });
});
