// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";

import { validateInput } from "../src/protocol/command-spec.js";

const RenameSchema = Type.Object({
  kind: Type.Literal("session.rename"),
  sessionId: Type.String(),
  title: Type.String({ minLength: 1 }),
});

test("validateInput: no schema passes through unchecked (migration-friendly)", () => {
  const r = validateInput(undefined, { anything: true });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { anything: true });
});

test("validateInput: valid message passes and is returned", () => {
  const msg = { kind: "session.rename", sessionId: "s1", title: "Hello" };
  const r = validateInput(RenameSchema, msg);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.title, "Hello");
});

test("validateInput: invalid message fails closed with bounded errors", () => {
  const r = validateInput(RenameSchema, { kind: "session.rename", sessionId: 42 });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.errors.length >= 1);
    assert.ok(r.errors.length <= 20);
  }
});
