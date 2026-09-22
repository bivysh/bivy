// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { parsePackagedOrigin, showAccountExtension, companionPolicyMessage, hasNativeSubscriptions, openNativeSubscriptions, synchronizeNativeSubscriptions, clearNativeSubscriptions } from "../packages/web/src/packaged-client.js";

test("packaged configuration is explicit and accepts only an HTTPS origin", () => {
  assert.equal(parsePackagedOrigin(undefined), null);
  assert.equal(parsePackagedOrigin(""), null);
  assert.equal(parsePackagedOrigin("https://cp.example/"), "https://cp.example");
  for (const value of ["http://localhost", "capacitor://localhost", "https://user:secret@cp.example", "https://cp.example/path", "https://cp.example?token=secret", "https://cp.example/#payload", "not a URL"]) {
    assert.throws(() => parsePackagedOrigin(value));
  }
});

test("ordinary browsers never activate native subscription hooks", async () => {
  let called = false;
  globalThis.__BIVY_PACKAGED_BRIDGE__ = {
    accountSubscriptions: {
      open: async () => { called = true; },
      synchronize: async () => { called = true; },
      clear: async () => { called = true; },
    },
  } as NonNullable<typeof globalThis.__BIVY_PACKAGED_BRIDGE__>;
  try {
    assert.equal(hasNativeSubscriptions(), false);
    await assert.rejects(openNativeSubscriptions("token"));
    await synchronizeNativeSubscriptions("token");
    await clearNativeSubscriptions();
    assert.equal(called, false);
  } finally { delete globalThis.__BIVY_PACKAGED_BRIDGE__; }
});

test("companion hides opaque extension presentation without changing browsers", () => {
  assert.equal(showAccountExtension(false), true);
  assert.equal(showAccountExtension(true), false);
  const message = "Upgrade at https://billing.example to continue";
  assert.equal(companionPolicyMessage(message, false), message);
  assert.equal(companionPolicyMessage(message, true), "This operation is not available for this account.");
  assert.equal(companionPolicyMessage("Computer is offline", true), "Computer is offline");
});
