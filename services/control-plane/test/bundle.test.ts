// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The container runs the esbuild bundle under plain `node`
// (deploy/Dockerfile.control-plane). Build it, boot it, and check it is ready and
// shuts down on SIGTERM; and that the bundled operator-login CLI loads.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnBuiltService, stopTestServices } from "../../test-service-process.js";

const cpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: cpDir, stdio: "inherit" });
assert.equal(built.status, 0, "scripts/build.mjs succeeds");

// Loading the CLI bundle resolves every import; with no DATABASE_URL it then stops
// at its own guard, before touching a database.
const env = { ...process.env };
delete env.DATABASE_URL;
const cli = spawnSync(process.execPath, ["dist/operator-login-cli.js"], { cwd: cpDir, env, encoding: "utf8" });
assert.notEqual(cli.status, 0);
assert.match(cli.stderr, /Operator login requires a durable DATABASE_URL/);

const port = await new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, () => {
    const address = server.address();
    server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port assigned")));
  });
  server.on("error", reject);
});

const child = spawnBuiltService(cpDir, { PORT: String(port), NODE_ENV: "development", DATABASE_URL: "" });
try {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      if ((await fetch(`http://localhost:${port}/readyz`)).ok) break;
    } catch {}
    if (attempt === 149) throw new Error("Bundled control plane did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const [code] = await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Bundled control plane ignored SIGTERM")), 5_000))]);
  assert.equal(code, 0, "SIGTERM runs the graceful shutdown and exits cleanly");
} finally {
  await stopTestServices([child]);
}
console.log("bundled control plane boots under plain node and shuts down on SIGTERM");
