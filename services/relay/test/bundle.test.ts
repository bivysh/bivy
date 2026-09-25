// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The container runs the esbuild bundle under plain `node` (deploy/Dockerfile.relay).
// Build it, boot it, and check it serves and exits promptly on SIGTERM — as PID 1
// it gets no default SIGTERM action, so the service must handle the signal itself.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnBuiltService, stopTestServices } from "../../test-service-process.js";

const relayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = spawnSync("npm", ["run", "build"], { cwd: relayDir, stdio: "inherit" });
assert.equal(built.status, 0, "npm run build succeeds");

const port = await new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, () => {
    const address = server.address();
    server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port assigned")));
  });
  server.on("error", reject);
});

const child = spawnBuiltService(relayDir, { PORT: String(port), RELAY_SECRET: "test-bundle-secret" });
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`http://localhost:${port}/healthz`)).ok) break;
    } catch {}
    if (attempt === 99) throw new Error("Bundled relay did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const [code] = await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Bundled relay ignored SIGTERM")), 2_000))]);
  assert.equal(code, 0, "SIGTERM exits cleanly");
} finally {
  await stopTestServices([child]);
}
console.log("bundled relay boots under plain node and exits on SIGTERM");
