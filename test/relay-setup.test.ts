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

/**
 * Regression test for https://github.com/bivysh/bivy/issues/2: `relay-setup`
 * used to hardcode `<repoRoot>/.bivy` instead of honouring `BIVY_DATA_DIR`
 * like every other entry point (server.ts, bivy-login.ts, secrets-cli.ts, …).
 * On a global npm install that wrote relay config into the package directory,
 * which is wiped on update.
 *
 * This runs the real setup path (`--session-token` skips interactive sign-in)
 * against a fake local control plane, with BIVY_DATA_DIR pointed at a temp
 * dir, and asserts relay.json and the node identity (node.json) land there —
 * not under the repo.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const relaySetupEntry = path.join(repoRoot, "src", "relay-setup.ts");

/** Minimal fake control plane: health check + node enrollment. */
function startFakeControlPlane(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/me") {
        // 401 unauthenticated is the "healthy" response checkControlPlane expects.
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthenticated" }));
        return;
      }
      if (req.method === "POST" && req.url === "/nodes/enroll") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ enrollmentToken: "enroll_test_token", node: { name: "fake-test-node" } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve({
        url: `http://127.0.0.1:${(address as { port: number }).port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function runRelaySetup(env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [relaySetupEntry, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("relay:setup honours BIVY_DATA_DIR instead of writing under the repo", async () => {
  const controlPlane = await startFakeControlPlane();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-relay-setup-test-"));
  const repoAppDir = path.join(repoRoot, ".bivy");
  const repoRelayJsonBefore = fs.existsSync(path.join(repoAppDir, "relay.json"))
    ? fs.readFileSync(path.join(repoAppDir, "relay.json"), "utf8")
    : null;

  try {
    const { code, stdout, stderr } = await runRelaySetup(
      {
        ...process.env,
        BIVY_DATA_DIR: dataDir,
      },
      [
        "--session-token",
        "test-session-token",
        "--control-plane",
        controlPlane.url,
        "--relay",
        "wss://relay.example.test",
        "--client",
        controlPlane.url,
      ],
    );

    assert.equal(code, 0, `relay-setup exited non-zero:\nstdout: ${stdout}\nstderr: ${stderr}`);

    // relay.json landed in BIVY_DATA_DIR, not <repoRoot>/.bivy.
    const relayJsonPath = path.join(dataDir, "relay.json");
    assert.ok(fs.existsSync(relayJsonPath), `expected ${relayJsonPath} to exist`);
    const relayConfig = JSON.parse(fs.readFileSync(relayJsonPath, "utf8"));
    assert.equal(relayConfig.url, "wss://relay.example.test");
    assert.equal(relayConfig.controlPlaneUrl, controlPlane.url);
    assert.equal(relayConfig.enrollmentToken, "enroll_test_token");

    // The node identity (node.json) also landed in BIVY_DATA_DIR.
    const nodeJsonPath = path.join(dataDir, "node.json");
    assert.ok(fs.existsSync(nodeJsonPath), `expected ${nodeJsonPath} to exist`);
    const nodeConfig = JSON.parse(fs.readFileSync(nodeJsonPath, "utf8"));
    assert.equal(typeof nodeConfig.nodeId, "string");
    assert.match(nodeConfig.nodeId, /^node_/);
    // The control plane assigned "fake-test-node"; relay-setup adopts it locally.
    assert.equal(nodeConfig.name, "fake-test-node");

    // The repo's own .bivy/relay.json (if any) must be untouched by this run.
    const repoRelayJsonAfter = fs.existsSync(path.join(repoAppDir, "relay.json"))
      ? fs.readFileSync(path.join(repoAppDir, "relay.json"), "utf8")
      : null;
    assert.equal(repoRelayJsonAfter, repoRelayJsonBefore, "repo .bivy/relay.json must not be written when BIVY_DATA_DIR is set");
  } finally {
    await controlPlane.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

/**
 * When the user picks self-hosted, setup passes only --control-plane (and
 * --relay) — the control-plane URL arrives via a flag, not the environment, and
 * no --client / BIVY_CLIENT_BASE_URL is supplied. The written clientBaseUrl (the
 * URL `bivy setup` opens at the end) must follow the chosen control plane, NOT
 * fall back to the baked-in hosted app. Regression for self-hosted installs that
 * finished by opening the hosted control plane instead of the configured one.
 */
test("relay:setup defaults clientBaseUrl to the self-hosted control plane, not the hosted app", async () => {
  const controlPlane = await startFakeControlPlane();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-relay-setup-selfhost-"));

  try {
    // Strip any hosted overrides so the run mirrors a clean self-hosted pick:
    // the only signal for the control plane is the --control-plane flag.
    const env = { ...process.env, BIVY_DATA_DIR: dataDir };
    delete env.BIVY_CLIENT_BASE_URL;
    delete env.BIVY_CONTROL_PLANE_URL;
    delete env.BIVY_HOSTED_DOMAIN;

    const { code, stdout, stderr } = await runRelaySetup(env, [
      "--session-token",
      "test-session-token",
      "--control-plane",
      controlPlane.url,
      "--relay",
      "wss://relay.example.test",
      // deliberately no --client
    ]);

    assert.equal(code, 0, `relay-setup exited non-zero:\nstdout: ${stdout}\nstderr: ${stderr}`);

    const relayConfig = JSON.parse(fs.readFileSync(path.join(dataDir, "relay.json"), "utf8"));
    assert.equal(relayConfig.controlPlaneUrl, controlPlane.url);
    assert.equal(
      relayConfig.clientBaseUrl,
      controlPlane.url,
      "clientBaseUrl must default to the chosen (self-hosted) control plane, not the hosted app",
    );
  } finally {
    await controlPlane.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
