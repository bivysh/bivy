// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { checkDiskAdmission, type StatfsFn } from "../src/harness/disk-admission.js";

// bsize=1 so bavail is bytes directly.
const statfsWithFree = (freeBytes: number): StatfsFn => () => ({ bavail: freeBytes, bsize: 1 });

test("disabled when minFreeBytes <= 0 → always allowed", () => {
  const d = checkDiskAdmission("/x", { minFreeBytes: 0, statfs: statfsWithFree(0) });
  assert.equal(d.allowed, true);
});

test("allows when free space is above the floor", () => {
  const d = checkDiskAdmission("/x", { minFreeBytes: 1000, statfs: statfsWithFree(5000) });
  assert.equal(d.allowed, true);
  assert.equal(d.freeBytes, 5000);
});

test("denies when free space is below the floor, with a reason", () => {
  const d = checkDiskAdmission("/x", { minFreeBytes: 10_000_000, statfs: statfsWithFree(1_000_000) });
  assert.equal(d.allowed, false);
  assert.equal(d.freeBytes, 1_000_000);
  assert.match(d.reason ?? "", /free/i);
});

test("free space computed as bavail * bsize", () => {
  const statfs: StatfsFn = () => ({ bavail: 10, bsize: 4096 });
  const d = checkDiskAdmission("/x", { minFreeBytes: 50_000, statfs }); // 40960 < 50000
  assert.equal(d.allowed, false);
  assert.equal(d.freeBytes, 40_960);
});

test("best-effort: a statfs error does not block (allowed)", () => {
  const statfs: StatfsFn = () => {
    throw new Error("statfs unavailable");
  };
  const d = checkDiskAdmission("/x", { minFreeBytes: 10_000_000, statfs });
  assert.equal(d.allowed, true);
});

test("reads BIVY_MIN_FREE_DISK_BYTES when minFreeBytes is not passed", () => {
  const prev = process.env.BIVY_MIN_FREE_DISK_BYTES;
  process.env.BIVY_MIN_FREE_DISK_BYTES = "10000";
  try {
    const denied = checkDiskAdmission("/x", { statfs: statfsWithFree(5000) });
    assert.equal(denied.allowed, false);
    const allowed = checkDiskAdmission("/x", { statfs: statfsWithFree(20000) });
    assert.equal(allowed.allowed, true);
  } finally {
    if (prev === undefined) delete process.env.BIVY_MIN_FREE_DISK_BYTES;
    else process.env.BIVY_MIN_FREE_DISK_BYTES = prev;
  }
});
