// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { parsePackagedOrigin, showAccountExtension, companionPolicyMessage } from "../packages/web/src/packaged-client.js";

test("packaged configuration is explicit and accepts only an HTTPS origin", () => {
  assert.equal(parsePackagedOrigin(undefined), null);
  assert.equal(parsePackagedOrigin(""), null);
  assert.equal(parsePackagedOrigin("https://cp.example/"), "https://cp.example");
  for (const value of ["http://localhost", "capacitor://localhost", "https://user:secret@cp.example", "https://cp.example/path", "https://cp.example?token=secret", "https://cp.example/#payload", "not a URL"]) {
    assert.throws(() => parsePackagedOrigin(value));
  }
});

test("companion hides opaque extension presentation without changing browsers", () => {
  assert.equal(showAccountExtension(false), true);
  assert.equal(showAccountExtension(true), false);
  const message = "Upgrade at https://billing.example to continue";
  assert.equal(companionPolicyMessage(message, false), message);
  assert.equal(companionPolicyMessage(message, true), "This operation is not available for this account.");
  assert.equal(companionPolicyMessage("Computer is offline", true), "Computer is offline");
});
