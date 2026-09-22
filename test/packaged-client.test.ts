// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { parseClientConfiguration, configuredAuthentication, showAccountExtension, accountPresentationMessage } from "../packages/web/src/client-config.js";
import { hasNativeSubscriptions, openNativeSubscriptions, synchronizeNativeSubscriptions, clearNativeSubscriptions } from "../packages/web/src/packaged-client.js";

const methods = { enabled: true, github: true, email: true, passwordConfigured: true };
const parse = (value: unknown) => parseClientConfiguration(JSON.stringify(value));

test("ordinary OSS defaults do not select deployment policy", () => {
  const config = parseClientConfiguration();
  assert.equal(config.platform, "browser");
  assert.equal(config.controlPlaneOrigin, null);
  assert.equal(config.connectionMode, "auto");
  assert.deepEqual(configuredAuthentication(methods, config), methods);
  assert.equal(showAccountExtension(config), true);
  assert.equal(accountPresentationMessage("Upgrade at https://example.invalid", config), "Upgrade at https://example.invalid");
  assert.deepEqual(parse(config), config);
});

test("neither server origin nor native platform selects login or billing policy", () => {
  for (const platform of ["browser", "native"]) {
    const config = parse({ platform, controlPlaneOrigin: "https://self-host.example/" });
    assert.equal(config.controlPlaneOrigin, "https://self-host.example");
    assert.equal(config.connectionMode, "auto");
    assert.deepEqual(configuredAuthentication(methods, config), methods);
    assert.equal(showAccountExtension(config), true);
    assert.equal(accountPresentationMessage("Purchase a subscription", config), "Purchase a subscription");
  }
});

test("explicit deployment presentation is independent of platform and cannot enable server-disabled auth", () => {
  const config = parse({ authenticationMethods: ["email"], accountExtension: "hidden", accountMessageRules: [{ terms: ["quota"], replacement: "Contact your administrator." }] });
  assert.equal(config.platform, "browser");
  assert.deepEqual(configuredAuthentication(methods, config), { ...methods, enabled: false, github: false });
  assert.equal(configuredAuthentication({ ...methods, email: false }, config).email, false);
  assert.equal(showAccountExtension(config), false);
  assert.equal(accountPresentationMessage("QUOTA exhausted", config), "Contact your administrator.");
  assert.equal(accountPresentationMessage("Computer offline", config), "Computer offline");
  assert.equal(accountPresentationMessage("Buy a subscription", config), "Buy a subscription"); // no built-in commercial vocabulary
});

test("malformed and misspelled configuration fails closed", () => {
  for (const value of [null, [], { version: 2 }, { platfrom: "native" }, { platform: "ios" }, { platform: "native" }, { connectionMode: "cloud" }, { accountExtension: "hide" }, { authenticationMethods: ["unknown"] }, { authenticationMethods: null }, { accountMessageRules: null }, { accountMessageRules: [{ terms: [""], replacement: "x" }] }]) assert.throws(() => parse(value));
  for (const origin of ["http://localhost", "capacitor://localhost", "https://user:secret@cp.example", "https://cp.example/path", "https://cp.example?token=secret", "https://cp.example/#payload", "not a URL"]) assert.throws(() => parse({ controlPlaneOrigin: origin }));
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
