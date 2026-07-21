import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecretVault, resolveSecret } from "../src/secrets.js";

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

console.log("secrets tests passed");
