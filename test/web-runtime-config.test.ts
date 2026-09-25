// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { webRuntimeConfigScript } from "../services/control-plane/src/web-runtime-config.js";
import { runtimeBoolean } from "../packages/web/src/runtime-config.js";
import { managedComputeEnabled, managedProviderConfigured } from "../services/control-plane/src/managed-compute.js";

test("runtime script exposes only a boolean opt-in, with the server kill switch dominant", () => {
  for (const value of [undefined, "", "0", "true", "1", "</script>"]) {
    const context: Record<string, unknown> = {};
    const env = { EPHEMERAL_MACHINES_ENABLED: value, RELAY_SECRET: "must-not-leak", MANAGED_COMPUTE_ENABLED: "1", VITE_EPHEMERAL_MACHINES_ENABLED: "1" };
    const script = webRuntimeConfigScript(env);
    runInNewContext(script, context);
    const config = context.__BIVY_RUNTIME_CONFIG__ as Record<string, unknown>;
    assert.deepEqual(Object.keys(config), ["ephemeralMachinesEnabled"]);
    assert.equal(config.ephemeralMachinesEnabled, value === "1");
    assert.equal(managedComputeEnabled(env), value === "1", "obsolete flags cannot bypass the single switch");
    assert.ok(!script.includes("must-not-leak"));
  }
});

test("operator configuration is independent of the launch switch and provider-specific", () => {
  assert.equal(managedProviderConfigured({ EPHEMERAL_MACHINES_ENABLED: "1" }), false, "BYO-only deployments need no managed hardening attestation");
  assert.equal(managedProviderConfigured({ MANAGED_PROVIDER_TOKEN_FLY: "  " }), false);
  const env = { EPHEMERAL_MACHINES_ENABLED: "0", MANAGED_PROVIDER_TOKEN_FLY: "test-operator-token" };
  assert.equal(managedProviderConfigured(env), true, "operator credentials remain configured for cleanup while off");
  assert.equal(managedProviderConfigured(env, "fly"), true);
  assert.equal(managedProviderConfigured(env, "aws"), false, "one configured provider never enables another");
});

test("runtime booleans override either build default, including explicit disable", () => {
  for (const fallback of [false, true]) {
    for (const value of [true, false, "1", "true", null, undefined, 1]) {
      assert.equal(runtimeBoolean("ephemeralMachinesEnabled", fallback, { ephemeralMachinesEnabled: value }), value === true);
    }
    for (const config of [undefined, null, {}]) {
      assert.equal(runtimeBoolean("ephemeralMachinesEnabled", fallback, config), fallback);
    }
  }
});
