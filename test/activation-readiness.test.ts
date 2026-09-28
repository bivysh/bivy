// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import { credentialReadiness } from "../src/runtime/activation-readiness.js";

test("readiness accepts configured environment credentials without a stored vault entry", async () => {
  const result = await credentialReadiness([{ id: "openai", configured: true }], async () => ({ probed: false, ok: true }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.providers, ["openai"]);
});

test("a rejected provider does not block another usable provider", async () => {
  const probe = async (id: string) => id === "anthropic"
    ? { probed: true, ok: false, reason: "rejected" }
    : { probed: false, ok: true };
  const rejected = { id: "anthropic", configured: true };
  assert.equal((await credentialReadiness([rejected], probe)).ok, false);
  assert.equal((await credentialReadiness([rejected, { id: "openai", configured: true }], probe)).ok, true);
});

test("missing credentials are not probed or reported ready", async () => {
  const result = await credentialReadiness([{ id: "openai", configured: false }], async () => { throw new Error("must not probe"); });
  assert.equal(result.configured, false);
  assert.equal(result.ok, false);
});
