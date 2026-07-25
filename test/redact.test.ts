import assert from "node:assert";
import { redactSecrets } from "../src/redact.js";

function run() {
  // GitHub token shapes.
  for (const tok of [
    "gho_EXAMPLEFAKETOKENFORTESTSONLY000000000",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "ghr_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ]) {
    const out = redactSecrets(`token is ${tok} ok`);
    assert.ok(!out.includes(tok), `masks ${tok.slice(0, 4)} token`);
    assert.ok(out.includes("***REDACTED***"), "inserts marker");
  }

  // Fine-grained PAT.
  const pat = "github_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789AbCdEfGhIjKlMnOp";
  assert.ok(!redactSecrets(`x ${pat} y`).includes(pat), "masks fine-grained PAT");

  // The exact leak vector: a token baked into a git remote URL.
  const remote = "origin\thttps://x-access-token:gho_EXAMPLEFAKETOKENFORTESTSONLY000000000@github.com/bivysh/bivy.git (fetch)";
  const scrubbed = redactSecrets(remote);
  assert.ok(!scrubbed.includes("gho_EXAMPLEFAKETOKENFORTESTSONLY000000000"), "token gone from remote URL");
  assert.ok(scrubbed.includes("x-access-token:***REDACTED***@github.com"), "keeps user, masks password");
  assert.ok(scrubbed.includes("github.com/bivysh/bivy.git"), "leaves the rest of the URL intact");

  // Redacting keeps JSON parseable (values only shrink).
  const json = JSON.stringify({ output: `remote: ${remote}`, note: "gho_EXAMPLEFAKETOKENFORTESTSONLY000000000" });
  const reparsed = JSON.parse(redactSecrets(json));
  assert.ok(!JSON.stringify(reparsed).includes("gho_EXAMPLE"), "no token survives in serialized JSON");

  // Model/provider and common SaaS API keys (the `cat .env` / `env` leak path).
  for (const key of [
    "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "sk_live_ABCDEF0123456789ABCDEF01",
    "rk_test_ABCDEF0123456789ABCDEF01",
    "gsk_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "xai-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456",
    "AKIAABCDEFGHIJKLMNOP",
    "xoxb-1234567890-ABCDEFGHIJKLMNOP",
  ]) {
    const out = redactSecrets(`export KEY=${key}`);
    assert.ok(!out.includes(key), `masks provider key ${key.slice(0, 6)}…`);
    assert.ok(out.includes("***REDACTED***"), "inserts marker for provider key");
  }

  // Bivy's own bearer tokens — device tokens, enrollment tokens, and account
  // session tokens (the exact `cat ~/.bivy/relay.json` / `cat ~/.bivy/node.json`
  // leak vectors from issue #109), plus the other `<prefix>_` shapes minted by
  // the control plane.
  for (const tok of [
    `mesh_${"A".repeat(43)}`, // device token (identity.ts)
    `enr_${"B".repeat(43)}`, // node enrollment token (relay-setup.ts -> relay.json)
    `sess_${"C".repeat(32)}`, // account session token
    `mlt_${"D".repeat(32)}`, // magic-link sign-in token
    `lnk_${"E".repeat(32)}`, // remote-device link grant
    `tkt_${"F".repeat(32)}`, // single-use relay ticket
  ]) {
    const out = redactSecrets(`token=${tok}`);
    assert.ok(!out.includes(tok), `masks bivy token ${tok.slice(0, 5)}…`);
    assert.ok(out.includes("***REDACTED***"), "inserts marker for bivy token");
  }
  // A short, non-token `mesh_`-prefixed fragment must not be over-redacted.
  assert.equal(redactSecrets("use the mesh_short flag"), "use the mesh_short flag", "leaves short mesh_ fragments alone");

  // JWTs (e.g. a GitHub App JWT printed while debugging createAppJwt()).
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJpYXQiOjE3MDAwMDAwMDAsImlzcyI6IjEyMzQ1In0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU";
  const jwtOut = redactSecrets(`Authorization: Bearer ${jwt}`);
  assert.ok(!jwtOut.includes(jwt), "masks JWT");
  assert.ok(jwtOut.includes("***REDACTED***"), "inserts marker for JWT");

  // Generic `Authorization: Bearer <token>` — a bearer shape with no specific
  // prefix of its own (e.g. a third-party bearer echoed while debugging).
  const bearerOut = redactSecrets("curl -H 'Authorization: Bearer abcDEF0123456789ghiJKL' https://example.com");
  assert.ok(!bearerOut.includes("abcDEF0123456789ghiJKL"), "masks generic bearer token");
  assert.ok(bearerOut.includes("Bearer ***REDACTED***"), "keeps the Bearer scheme, masks the credential");
  // The bare word "Bearer" with nothing following must not be touched.
  assert.equal(redactSecrets("Bearer of good news"), "Bearer of good news", "leaves bare 'Bearer' word alone");

  // Pairing secrets / room keys / private keys: high-entropy values with no
  // prefix of their own, identified by the known JSON field name next to them
  // (device-registry.ts, pairing-crypto.ts, server.ts's GitHub App vault).
  const secretsJson = JSON.stringify({
    roomKeyB64: "r".repeat(44),
    privateKeyB64: "p".repeat(44),
    pairSecretB64: "s".repeat(44),
    vaultKeyB64: "v".repeat(44),
    deviceSecret: "d".repeat(44),
    webhookSecret: "w".repeat(44),
    sessionToken: "t".repeat(44),
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\\nexample-fixture-not-a-real-key-MIIBVQIBADANBgkqhkiG9w0BAQ\\n-----END PRIVATE KEY-----",
    // Public keys are not secret and must survive untouched.
    publicKeyB64: "public-key-value-not-a-secret",
  });
  const secretsOut = redactSecrets(secretsJson);
  for (const value of ["r".repeat(44), "p".repeat(44), "s".repeat(44), "v".repeat(44), "d".repeat(44), "w".repeat(44), "t".repeat(44)]) {
    assert.ok(!secretsOut.includes(value), `masks known-key-adjacent secret value (${value[0]})`);
  }
  assert.ok(!secretsOut.includes("MIIBVQIBADANBgkqhkiG9w0BAQ"), "masks PEM private key value");
  assert.ok(secretsOut.includes("public-key-value-not-a-secret"), "leaves public key values alone");
  assert.ok(JSON.parse(secretsOut), "redacted JSON with known-secret fields is still valid JSON");

  // Non-secret text is untouched.
  assert.equal(redactSecrets("just a normal https://github.com/bivysh/bivy line"), "just a normal https://github.com/bivysh/bivy line", "leaves credential-free URLs alone");
  // A short `sk-` fragment is not a key and must not be over-redacted.
  assert.equal(redactSecrets("use the sk-foo flag"), "use the sk-foo flag", "leaves short sk- fragments alone");
  assert.equal(redactSecrets(""), "", "empty passthrough");

  console.log("redact: all tests passed");
}

run();
