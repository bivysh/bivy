// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("../scripts/smoke-ephemeral-continuity.mts", import.meta.url));

test("continuity probe requires explicit billable opt-in and never prints the operator credential", () => {
  const secret = "test-operator-secret-must-not-print";
  const result = spawnSync(process.execPath, ["--import", "tsx", script], {
    env: { ...process.env, BIVY_CONTINUITY: "0", MANAGED_PROVIDER_TOKEN_FLY: secret }, encoding: "utf8", timeout: 20_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Set BIVY_CONTINUITY=1/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
});

test("continuity probe refuses a production control plane before account or cloud effects", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", script], {
    env: { ...process.env, BIVY_CONTINUITY: "1", BIVY_CONTINUITY_CONTROL_PLANE_URL: "https://production.example" }, encoding: "utf8", timeout: 20_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /isolated loopback control plane/);
});
