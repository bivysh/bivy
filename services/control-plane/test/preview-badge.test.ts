// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// "Made with Bivy" on shared previews: a machine may hide it only when its
// account's plan is one the deployment lists (BIVY_PREVIEW_BADGE_HIDE_PLANS).
import type { ChildProcess } from "node:child_process";
import { spawnTestService, stopTestServices } from "../../test-service-process.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

const cpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const procs: ChildProcess[] = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function expect(condition: boolean, message: string) {
  if (!condition) throw new Error(`✗ FAIL: ${message}`);
  console.log(`✓ ${message}`);
}
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port")));
    });
    server.on("error", reject);
  });
}
async function json(port: number, method: string, pathname: string, body?: unknown, token?: string) {
  const response = await fetch(`http://localhost:${port}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
}

async function main() {
  const port = await freePort();
  procs.push(spawnTestService(cpDir, { PORT: String(port), RELAY_SECRET: "preview-badge-test", BIVY_PREVIEW_BADGE_HIDE_PLANS: "pro, team" }));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${port}/healthz`)).ok) break; } catch {}
    await delay(100);
  }
  const token = (await json(port, "POST", "/auth/dev-login", { email: "badge@example.com" })).body.token;
  const node = (await json(port, "POST", "/nodes/enroll", { nodeId: "badge-node", name: "laptop" }, token)).body.enrollmentToken;
  expect((await json(port, "GET", "/node/preview-badge")).status === 401, "only an enrolled machine can ask");
  const free = await json(port, "GET", "/node/preview-badge", undefined, node);
  expect(free.status === 200 && free.body.hideAllowed === false, "an account whose plan is not listed keeps the badge");
  console.log("\nAll preview badge checks passed.");
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopTestServices(procs);
}
