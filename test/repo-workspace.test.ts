import assert from "node:assert/strict";
import { parseGitHubRemote, parseRepo } from "../src/repo-workspace.js";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

check("parses owner/repo", () => {
  assert.deepEqual(parseRepo("bivysh/bivy"), { owner: "bivysh", repo: "bivy", slug: "bivysh/bivy" });
});

check("tolerates https URL and .git", () => {
  assert.deepEqual(parseRepo("https://github.com/bivysh/bivy.git"), { owner: "bivysh", repo: "bivy", slug: "bivysh/bivy" });
});

check("tolerates ssh form", () => {
  assert.deepEqual(parseRepo("git@github.com:bivysh/bivy.git"), { owner: "bivysh", repo: "bivy", slug: "bivysh/bivy" });
});

check("rejects junk and injection attempts", () => {
  assert.equal(parseRepo("nope"), undefined);
  assert.equal(parseRepo("a/b/c"), undefined);
  assert.equal(parseRepo("owner/repo; rm -rf /"), undefined);
  assert.equal(parseRepo("owner/repo/../../evil"), undefined);
  assert.equal(parseRepo("https://evil.example/owner/repo"), undefined);
  assert.equal(parseRepo(""), undefined);
});

check("infers slug from GitHub remote URLs", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/bivysh/bivy.git"), { owner: "bivysh", repo: "bivy", slug: "bivysh/bivy" });
  assert.deepEqual(parseGitHubRemote("https://x-access-token:secret@github.com/bivysh/bivy.git"), { owner: "bivysh", repo: "bivy", slug: "bivysh/bivy" });
  assert.deepEqual(parseGitHubRemote("git@github.com:bivysh/bivy.git"), { owner: "bivysh", repo: "bivy", slug: "bivysh/bivy" });
  assert.equal(parseGitHubRemote("https://gitlab.com/bivysh/bivy.git"), undefined);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nrepo-workspace: all tests passed");
