import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecretVault, resolveSecret, defaultSecretsDir } from "../src/secrets.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-secrets-"));
const vault = new SecretVault(dir);

vault.setLocal("github.repo-token", "ghp_test_secret");
assert.equal(await vault.resolve("github.repo-token"), "ghp_test_secret");
assert.equal(await vault.resolve("secret://github.repo-token"), "ghp_test_secret");
assert.equal(await resolveSecret("secret://github.repo-token", dir), "ghp_test_secret");

const raw = fs.readFileSync(path.join(dir, "secrets.json"), "utf8");
assert.ok(!raw.includes("ghp_test_secret"), "plaintext secret must not be written to secrets.json");
assert.ok(fs.existsSync(path.join(dir, "secrets.key")), "local vault key should be created");

process.env.BIVY_TEST_SECRET = "from-env";
vault.setReference("env-test", "env://BIVY_TEST_SECRET");
assert.equal(await vault.resolve("env-test"), "from-env");
assert.equal(await vault.resolve("env://BIVY_TEST_SECRET"), "from-env");

assert.equal(vault.delete("github.repo-token"), true);
assert.equal(await vault.resolve("github.repo-token"), undefined);

// --- reliability: no silent data loss / regeneration on corruption ---

{
  // A corrupt (but present) secrets.json must not be silently reset to empty —
  // that would look like "all my secrets vanished" the next time anything writes.
  const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-secrets-corrupt-"));
  fs.writeFileSync(path.join(corruptDir, "secrets.json"), "{not valid json");
  assert.throws(() => new SecretVault(corruptDir), /corrupt/i, "corrupt secrets.json must throw, not reset to empty");
}

{
  // A missing secrets.json is the normal "nothing stored yet" case and must not throw.
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-secrets-fresh-"));
  assert.doesNotThrow(() => new SecretVault(freshDir));
}

{
  // A truncated/malformed secrets.key must throw rather than silently mint a new
  // key (which would make every previously stored "local" secret undecryptable).
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-secrets-key-"));
  fs.writeFileSync(path.join(keyDir, "secrets.key"), "not-base64-32-bytes\n");
  const brokenVault = new SecretVault(keyDir);
  assert.throws(() => brokenVault.setLocal("x", "y"), /invalid/i);
}

{
  // defaultSecretsDir() must resolve outside the current working directory —
  // regression guard for the old process.cwd()/.bivy fallback.
  const savedDataDir = process.env.BIVY_DATA_DIR;
  delete process.env.BIVY_DATA_DIR;
  try {
    const resolved = defaultSecretsDir();
    assert.equal(resolved, path.join(os.homedir(), ".bivy"));
    assert.notEqual(resolved, path.join(process.cwd(), ".bivy"));
  } finally {
    if (savedDataDir === undefined) delete process.env.BIVY_DATA_DIR;
    else process.env.BIVY_DATA_DIR = savedDataDir;
  }
}

{
  // Refuse to mint the master key inside a git working tree, even if explicitly
  // pointed there (defense-in-depth against BIVY_DATA_DIR being set to "." etc).
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-secrets-repo-"));
  fs.mkdirSync(path.join(repoDir, ".git"));
  const nested = path.join(repoDir, "nested", "app-dir");
  fs.mkdirSync(nested, { recursive: true });
  const repoVault = new SecretVault(nested);
  assert.throws(() => repoVault.setLocal("x", "y"), /git working tree/i);
}

console.log("secrets tests passed");
