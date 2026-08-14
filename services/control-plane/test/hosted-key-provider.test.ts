// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import {
  decryptHostedSecret,
  encryptHostedSecret,
  hostedKeyProvider,
  setHostedKeyProvider,
  type HostedKeyProvider,
  type SecretEnvelope,
} from "../src/hosted-crypto.js";

const calls: string[] = [];
const envelope: SecretEnvelope = { v: 1, kid: "kms-key", iv: "opaque", ct: "ciphertext", tag: "tag" };
const kms: HostedKeyProvider = {
  available: async () => true,
  primaryKeyId: async () => "kms-key",
  encrypt: async (accountId, plaintext) => { calls.push(`seal:${accountId}:${plaintext}`); return envelope; },
  decrypt: async (accountId, value) => { calls.push(`open:${accountId}:${value.kid}`); return "secret"; },
};
setHostedKeyProvider(kms);
assert.equal(hostedKeyProvider(), kms);
assert.deepEqual(await encryptHostedSecret("acct", "secret"), envelope);
assert.equal(await decryptHostedSecret("acct", envelope), "secret");
assert.deepEqual(calls, ["seal:acct:secret", "open:acct:kms-key"]);
setHostedKeyProvider(null);
console.log("hosted-key-provider: all tests passed");
