// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { publicManagedLaunchError } from "../src/managed-launch-error.js";

test("missing manifests produce an actionable but credential-free diagnostic", () => {
  const result = publicManagedLaunchError(new Error('Provider failed to create machine (HTTP 400: failed to get manifest registry/private:tag MANIFEST_UNKNOWN secret-token)'));
  assert.equal(result.code, "managed_image_unavailable");
  assert.match(result.error, /deployment needs repair/);
  assert.match(result.error, /same launch/);
  assert.ok(!JSON.stringify(result).includes("secret-token"));
  assert.ok(!JSON.stringify(result).includes("registry/private"));
});

test("unclassified provider failures never echo sensitive details", () => {
  const result = publicManagedLaunchError(new Error("Authorization: Bearer secret-token"));
  assert.equal(result.code, "managed_launch_failed");
  assert.ok(!JSON.stringify(result).includes("secret-token"));
});
