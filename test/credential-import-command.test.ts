import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createCredentialVault } from "../src/runtime/credential-store.js";
import { discoverNativeAuth } from "../src/runtime/native-auth-import.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-explicit-import-"));
const oldHome = process.env.CODEX_HOME;
const home = path.join(root, "codex");
fs.mkdirSync(home);
process.env.CODEX_HOME = home;
const secret = "secret-never-print-this";
const run = (...args: string[]) => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/credentials-cli.ts", "import", "codex", ...args], {
    env: { ...process.env, BIVY_DATA_DIR: root }, encoding: "utf8",
  });
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), "secrets must not be printed");
  return result;
};
try {
  assert.equal(discoverNativeAuth("codex").status, "missing");
  fs.writeFileSync(path.join(home, "auth.json"), `{"${secret}`);
  assert.equal(discoverNativeAuth("codex").status, "unreadable");
  assert.equal(run("--dry-run").status, 0);
  fs.writeFileSync(path.join(home, "auth.json"), "{}");
  assert.equal(discoverNativeAuth("codex").status, "unsupported");
  const native = JSON.stringify({ OPENAI_API_KEY: secret });
  fs.writeFileSync(path.join(home, "auth.json"), native);
  const vault = createCredentialVault(path.join(root, "credentials"));
  assert.equal(run("--dry-run").status, 0);
  assert.equal((await vault.listRecords()).length, 0);
  assert.equal(run().status, 1, "noninteractive consent required");
  assert.equal(run("--yes").status, 1, "scope required");
  assert.equal(run("--sync", "wrong", "--yes").status, 1);
  assert.equal(run("--unknown").status, 1);
  assert.equal(run("--sync", "node", "--yes").status, 0);
  assert.equal((await vault.readRecord("openai"))?.sync, "node");
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "different" }));
  assert.equal(run("--sync", "account", "--yes").status, 0);
  assert.deepEqual((await vault.readRecord("openai"))?.source, { kind: "stored", cred: { type: "api_key", key: secret } });
  assert.equal((await vault.readRecord("openai"))?.sync, "node", "conflict must not widen sync");
  assert.equal(run("--sync", "account", "--label", "work", "--yes").status, 0);
  assert.equal((await vault.readRecord("openai", "work"))?.sync, "account");
  const exported = await vault.exportSyncableRecords();
  assert.ok(exported["openai:work"]);
  assert.ok(!exported["openai:default"]);
  assert.equal(fs.readFileSync(path.join(home, "auth.json"), "utf8"), JSON.stringify({ OPENAI_API_KEY: "different" }));
  const record = { provider: "xai", label: "race", sync: "node" as const, origin: "agent-native" as const, source: { kind: "stored" as const, cred: { type: "api_key" as const, key: secret } } };
  const outcomes = await Promise.all([vault.putRecordIfAbsent(record), vault.putRecordIfAbsent(record)]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  console.log("ok: native credential import discovery, consent, scope, conflicts, redaction and atomic insert");
} finally {
  if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
  fs.rmSync(root, { recursive: true, force: true });
}
