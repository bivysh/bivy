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

  // Non-secret text is untouched.
  assert.equal(redactSecrets("just a normal https://github.com/bivysh/bivy line"), "just a normal https://github.com/bivysh/bivy line", "leaves credential-free URLs alone");
  assert.equal(redactSecrets(""), "", "empty passthrough");

  console.log("redact: all tests passed");
}

run();
