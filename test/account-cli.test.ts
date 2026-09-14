// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "bin", "bivy.mjs");

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("bivy logout revokes the machine and removes only account-bound local state", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-account-logout-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-account-home-"));
  let deleteAuthorization = "";
  const server = http.createServer((req, res) => {
    if (req.method === "DELETE" && req.url === "/node") {
      deleteAuthorization = String(req.headers.authorization || "");
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const relayPath = path.join(dataDir, "relay.json");
  const accountVaultPath = path.join(dataDir, "model-auth-vault.json");
  const credentialPath = path.join(dataDir, "credentials", "keep-me");
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
  fs.writeFileSync(credentialPath, "local provider credential");
  fs.writeFileSync(accountVaultPath, "account key");
  fs.writeFileSync(path.join(dataDir, "cli.json"), JSON.stringify({ port: 65534, service: false }));
  fs.writeFileSync(relayPath, JSON.stringify({
    url: "wss://relay.example.test",
    controlPlaneUrl: `http://127.0.0.1:${address.port}`,
    enrollmentToken: "enrollment-test-token",
  }));

  try {
    const result = await runCli(["logout"], { BIVY_DATA_DIR: dataDir, HOME: home });
    assert.equal(result.code, 0, `logout failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.equal(deleteAuthorization, "Bearer enrollment-test-token");
    assert.equal(fs.existsSync(relayPath), false);
    assert.equal(fs.existsSync(accountVaultPath), false);
    assert.equal(fs.readFileSync(credentialPath, "utf8"), "local provider credential");
    assert.match(result.stdout, /Signed out/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
