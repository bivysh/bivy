// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { seal, open } from "../src/e2e.js";
import { recoverModelAuthKey } from "../src/model-auth-key-recovery.js";

const currentKey = randomBytes(32).toString("base64");
const staleKey = randomBytes(32).toString("base64");
const ciphertext = seal(Buffer.from(currentKey, "base64"), JSON.stringify({ records: { example: "test-credential" } }));
const decrypt = (key: string) => JSON.parse(open(Buffer.from(key, "base64"), ciphertext));

test("a valid local key does not need a peer wrap", () => {
  const recovered = recoverModelAuthKey({ localKey: currentKey, unwrap: () => { throw new Error("must not unwrap"); }, decrypt });
  assert.equal(recovered?.key, currentKey);
  assert.deepEqual(recovered?.value, { records: { example: "test-credential" } });
});

test("a stale cached key falls back to a fresh peer wrap in the same poll", () => {
  const recovered = recoverModelAuthKey({ localKey: staleKey, unwrap: () => currentKey, decrypt });
  assert.equal(recovered?.key, currentKey);
  assert.deepEqual(recovered?.value, { records: { example: "test-credential" } });
});

test("an unwrapped stale key is rejected rather than cached as recovered", () => {
  assert.equal(recoverModelAuthKey({ unwrap: () => staleKey, decrypt }), undefined);
});

test("a wrap that cannot be opened also enters key recovery", () => {
  assert.equal(recoverModelAuthKey({ localKey: staleKey, unwrap: () => { throw new Error("invalid wrap"); }, decrypt }), undefined);
});
