// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { ChildProcess } from "node:child_process";
import { spawnTestService, stopTestServices } from "../../test-service-process.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

/**
 * `/auth/test-login`, the sign-in automated end-to-end tests use. Exercises the
 * real route: off without configuration, refuses a wrong secret and any address
 * outside the reserved domain, and signs a test address in with a session that
 * works and a link that hands it to a browser.
 */

const cpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "t".repeat(40);
const procs: ChildProcess[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port assigned"))));
    });
    server.on("error", reject);
  });
}

async function start(extraEnv: Record<string, string> = {}): Promise<number> {
  const port = await freePort();
  procs.push(spawnTestService(cpDir, { PORT: String(port), RELAY_SECRET: "test-secret-test-login", ...extraEnv }));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://localhost:${port}/healthz`)).status < 500) return port; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("control plane did not start");
}

async function req(port: number, method: string, pathname: string, body?: unknown, token?: string) {
  const res = await fetch(`http://localhost:${port}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

function expect(cond: boolean, msg: string) {
  if (!cond) throw new Error(`✗ FAIL: ${msg}`);
  console.log(`✓ ${msg}`);
}

async function main() {
  const off = await start();
  expect((await req(off, "POST", "/auth/test-login", { email: "a@agents.test", secret: SECRET })).status === 404, "off unless configured");

  const port = await start({ TEST_SIGN_IN_SECRET: SECRET, TEST_SIGN_IN_DOMAIN: "agents.test" });
  expect((await req(port, "POST", "/auth/test-login", { email: "a@agents.test", secret: "wrong" })).status === 401, "a wrong secret is refused");
  expect((await req(port, "POST", "/auth/test-login", { email: "someone@example.com", secret: SECRET })).status === 400, "a real-looking address is refused even with the secret");

  const login = await req(port, "POST", "/auth/test-login", { email: "Run-1@Agents.Test", secret: SECRET });
  expect(login.status === 200 && typeof login.json?.token === "string", "a test address signs in");
  expect(login.json.account.email === "run-1@agents.test", "the address is normalised");
  expect((await req(port, "GET", "/api/push/preferences", undefined, login.json.token)).status === 200, "the session works");
  const fragment = String(login.json.signInUrl).split("#")[1] ?? "";
  expect(JSON.parse(Buffer.from(fragment, "base64url").toString()).session === login.json.token, "the link hands the same session to a browser");
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopTestServices(procs);
}
