// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { hostedEnrollment } from "../src/hosted-enrollment.js";
import type { HostedMachineAttempt } from "../src/store.js";
process.env.HOSTED_CREDENTIAL_KEY = Buffer.alloc(32, 19).toString("base64");

function fresh(): HostedMachineAttempt {
  return { accountId: "account", attemptId: "attempt", provider: "fly", nodeId: "node", state: "requested",
    desired: { bootstrapIdentityVersion: 1, requestFingerprint: "preserve-me" }, retryCount: 0, createdAt: "", updatedAt: "" };
}

test("enrollment receipt is encrypted, account scoped, immutable and reusable after restart", async () => {
  let attempt = fresh();
  const save = async (next: HostedMachineAttempt) => { attempt = JSON.parse(JSON.stringify(next)); };
  await hostedEnrollment("account", () => attempt, save).persist("node", "original-bearer");
  assert.ok(!JSON.stringify(attempt).includes("original-bearer"));
  assert.equal(attempt.desired.requestFingerprint, "preserve-me");
  const retry = hostedEnrollment("account", () => attempt, save, true);
  assert.equal(retry.token, "original-bearer");
  await retry.persist("node", "original-bearer");
  await assert.rejects(() => retry.persist("node", "different"), /identity changed/);
  await assert.rejects(() => retry.persist("other-node", "original-bearer"), /matching durable attempt/);
  assert.throws(() => hostedEnrollment("different-account", () => attempt, save, true));
});

test("persistence fails closed; safe pre-enrollment retries differ from unknown legacy launches", async () => {
  const attempt = fresh();
  const fail = async () => { throw new Error("database unavailable"); };
  await assert.rejects(() => hostedEnrollment("account", () => undefined, fail).persist("node", "bearer"), /matching durable attempt/);
  await assert.rejects(() => hostedEnrollment("account", () => attempt, fail).persist("node", "bearer"), /database unavailable/);
  assert.equal(hostedEnrollment("account", () => attempt, fail, true).token, undefined);
  delete attempt.desired.bootstrapIdentityVersion;
  assert.throws(() => hostedEnrollment("account", () => attempt, fail, true), /Legacy launch/);
});
