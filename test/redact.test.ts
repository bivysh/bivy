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

  // Non-secret text is untouched.
  assert.equal(redactSecrets("just a normal https://github.com/bivysh/bivy line"), "just a normal https://github.com/bivysh/bivy line", "leaves credential-free URLs alone");
  // A short `sk-` fragment is not a key and must not be over-redacted.
  assert.equal(redactSecrets("use the sk-foo flag"), "use the sk-foo flag", "leaves short sk- fragments alone");
  assert.equal(redactSecrets(""), "", "empty passthrough");

  console.log("redact: all tests passed");
}

run();
