// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Ephemeral rebuild room-key adoption: a first-run daemon that is REUSING a
// torn-down session's node id must adopt the pre-shared room key (relay.json
// `e2eKey`) so it can decrypt the restored snapshot. An already-paired node, or
// a malformed seed, must never have its room key overwritten/adopted.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { PairingStore } from "../src/device-registry.js";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-room-key-adopt-"));
}

check("first-run node adopts a valid 32-byte seed", () => {
  const dir = tmpDir();
  const seed = randomBytes(32).toString("base64");
  const store = PairingStore.load(dir, seed);
  assert.equal(store.roomKey().toString("base64"), seed);
  // Persisted, so a later load without a seed keeps the adopted key.
  const reloaded = PairingStore.load(dir);
  assert.equal(reloaded.roomKey().toString("base64"), seed);
});

check("an existing pairing.json is never overwritten by a seed", () => {
  const dir = tmpDir();
  const first = PairingStore.load(dir); // fresh random key, persisted
  const original = first.roomKey().toString("base64");
  const differentSeed = randomBytes(32).toString("base64");
  assert.notEqual(differentSeed, original);
  const second = PairingStore.load(dir, differentSeed);
  assert.equal(second.roomKey().toString("base64"), original, "seed must be ignored when paired");
});

check("a malformed seed falls back to a fresh random 32-byte key", () => {
  for (const bad of ["not-base64!!", randomBytes(16).toString("base64"), randomBytes(48).toString("base64"), ""]) {
    const dir = tmpDir();
    const store = PairingStore.load(dir, bad);
    const key = store.roomKey();
    assert.equal(key.length, 32, `key must be 32 bytes for seed ${JSON.stringify(bad)}`);
    assert.notEqual(key.toString("base64"), bad, "must not adopt a malformed seed verbatim");
  }
});

check("no seed on a first-run node still mints a random 32-byte key", () => {
  const a = PairingStore.load(tmpDir()).roomKey();
  const b = PairingStore.load(tmpDir()).roomKey();
  assert.equal(a.length, 32);
  assert.notEqual(a.toString("base64"), b.toString("base64"), "fresh keys must differ");
});

console.log(`pairing-room-key-adoption: ${failures} test(s) failed`);
if (failures > 0) process.exit(1);
