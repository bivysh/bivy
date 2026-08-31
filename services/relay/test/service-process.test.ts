// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnTestService, stopTestServices } from "../../test-service-process.js";

const relayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = await new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, () => {
    const address = server.address();
    server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port assigned")));
  });
  server.on("error", reject);
});

const child = spawnTestService(relayDir, {
  PORT: String(port),
  RELAY_SECRET: "test-process-secret",
});

try {
  assert.equal(child.spawnfile, process.execPath, "the service runs directly under Node, without an npx/tsx wrapper process");
  assert.deepEqual(child.spawnargs.slice(1, 4), ["--import", "tsx", "src/index.ts"]);

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`http://localhost:${port}/healthz`)).ok) break;
    } catch {}
    if (attempt === 99) throw new Error("Relay did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
} finally {
  await stopTestServices([child]);
}

assert.ok(child.exitCode !== null || child.signalCode !== null, "cleanup waits for the service to exit");
console.log("test service processes start directly and are reaped during cleanup");
