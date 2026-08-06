// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { InMemoryLocationRegistry } from "../src/runtime/location-registry.js";

test("record/lookup/forget round-trip", async () => {
  const reg = new InMemoryLocationRegistry<{ termId: string }>();
  await reg.record("sess-1", { termId: "term-a" });
  assert.deepEqual(await reg.lookup("sess-1"), { termId: "term-a" });
  assert.equal(reg.size, 1);
  await reg.forget("sess-1");
  assert.equal(await reg.lookup("sess-1"), undefined);
  assert.equal(reg.size, 0);
});

test("lookup of an unknown key is undefined", async () => {
  const reg = new InMemoryLocationRegistry<{ n: number }>();
  assert.equal(await reg.lookup("nope"), undefined);
});

test("record replaces an existing entry", async () => {
  const reg = new InMemoryLocationRegistry<{ termId: string }>();
  await reg.record("s", { termId: "a" });
  await reg.record("s", { termId: "b" });
  assert.deepEqual(await reg.lookup("s"), { termId: "b" });
  assert.equal(reg.size, 1);
});

test("an empty key is rejected", async () => {
  const reg = new InMemoryLocationRegistry<{ n: number }>();
  await assert.rejects(reg.record("", { n: 1 }), /location key is required/);
});

test("stored values are copies (no aliasing with caller mutations)", async () => {
  const reg = new InMemoryLocationRegistry<{ termId: string }>();
  const v = { termId: "a" };
  await reg.record("s", v);
  v.termId = "mutated";
  assert.equal((await reg.lookup("s"))?.termId, "a");
  const read = (await reg.lookup("s"))!;
  read.termId = "also";
  assert.equal((await reg.lookup("s"))?.termId, "a");
});
