// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import {
  decryptSecret,
  encryptSecret,
  hostedEncryptionAvailable,
  hostedPrimaryKid,
  initializeHostedKeyring,
} from "../src/hosted-crypto.js";

const saved = { ...process.env };
try {
  const envKey = Buffer.alloc(32, 1).toString("base64");
  process.env.HOSTED_KEYRING_SOURCE = "env";
  process.env.HOSTED_CREDENTIAL_KEY = envKey;
  await initializeHostedKeyring();
  assert.equal(hostedPrimaryKid(), "default");
  assert.equal(decryptSecret("acct", encryptSecret("acct", "secret")), "secret");

  const kmsKey = Buffer.alloc(32, 2).toString("base64");
  process.env.HOSTED_KEYRING_SOURCE = "aws-kms";
  process.env.BIVY_HOSTED_KEY_KMS_REGION = "us-east-1";
  process.env.BIVY_HOSTED_KEY_KMS_CIPHERTEXT = "v2:encrypted-data-key";
  process.env.HOSTED_CREDENTIAL_KEY_PRIMARY = "v2";
  process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
  process.env.AWS_SECRET_ACCESS_KEY = "secret";
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  await initializeHostedKeyring({
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ Plaintext: kmsKey }), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(hostedPrimaryKid(), "v2");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://kms.us-east-1.amazonaws.com/");
  assert.match(String((requests[0].init?.headers as Record<string, string>).authorization), /^AWS4-HMAC-SHA256 /);
  assert.equal(decryptSecret("acct", encryptSecret("acct", "kms secret")), "kms secret");

  // A selected but broken KMS source must not fall back to the still-present env key.
  process.env.BIVY_HOSTED_KEY_KMS_CIPHERTEXT = "";
  await initializeHostedKeyring({ fetchImpl: fetch });
  assert.equal(hostedEncryptionAvailable(), false);
  assert.throws(() => encryptSecret("acct", "must fail"), /No hosted credential key configured/);
} finally {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
  await initializeHostedKeyring();
}
console.log("hosted-keyring-source: all tests passed");
