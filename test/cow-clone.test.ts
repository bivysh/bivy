// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cloneDir, detectCloneStrategy, __resetCloneStrategyForTests, type CloneStrategy } from "../src/harness/cow-clone.js";

const VALID: CloneStrategy[] = ["apple-clonefile", "reflink", "copy"];

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("detectCloneStrategy returns a valid, cached strategy", () => {
  __resetCloneStrategyForTests();
  const dir = tmp("bivy-cow-detect-");
  const s = detectCloneStrategy(dir);
  assert.ok(VALID.includes(s), `strategy ${s} is one of ${VALID.join("/")}`);
  assert.equal(detectCloneStrategy(dir), s, "cached on second call");
});

test("cloneDir reproduces the tree exactly (whatever the strategy)", () => {
  const base = tmp("bivy-cow-clone-");
  const src = path.join(base, "src");
  fs.mkdirSync(path.join(src, "nested"), { recursive: true });
  fs.writeFileSync(path.join(src, "a.txt"), "alpha");
  fs.writeFileSync(path.join(src, "nested", "b.txt"), "beta");

  const dst = path.join(base, "dst");
  const strategy = cloneDir(src, dst);

  assert.ok(VALID.includes(strategy));
  assert.equal(fs.readFileSync(path.join(dst, "a.txt"), "utf8"), "alpha");
  assert.equal(fs.readFileSync(path.join(dst, "nested", "b.txt"), "utf8"), "beta");
});

test("clone is independent: writing the clone does not change the source", () => {
  const base = tmp("bivy-cow-indep-");
  const src = path.join(base, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "f.txt"), "original");

  const dst = path.join(base, "dst");
  cloneDir(src, dst);

  // Mutating the clone must not touch the source — true for both a real CoW
  // clone (diverges on write) and the plain-copy fallback.
  fs.writeFileSync(path.join(dst, "f.txt"), "changed");
  assert.equal(fs.readFileSync(path.join(src, "f.txt"), "utf8"), "original");
  assert.equal(fs.readFileSync(path.join(dst, "f.txt"), "utf8"), "changed");
});

test("cloneDir throws if the source does not exist", () => {
  const base = tmp("bivy-cow-missing-");
  assert.throws(() => cloneDir(path.join(base, "nope"), path.join(base, "dst")));
});
