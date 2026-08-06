// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

/**
 * Account-scoped notification preferences API (`/api/push/preferences`).
 * Exercises the real HTTP routes in src/index.ts:
 *  - unauthenticated reads are refused,
 *  - a fresh account defaults to all six kinds enabled,
 *  - PUT merges a partial patch and ignores unknown keys,
 *  - the merge persists across requests.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cpDir = path.resolve(testDir, "..");

const KINDS = ["question_asked", "approval_requested", "agent_waiting", "session_done", "session_error", "terminal_bell"];

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

const procs: ChildProcess[] = [];
function cleanup(code: number) {
  for (const p of procs) p.kill("SIGTERM");
  process.exit(code);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startControlPlane(extraEnv: Record<string, string>): Promise<number> {
  const port = await freePort();
  const child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: cpDir,
    env: { ...process.env, PORT: String(port), RELAY_SECRET: "test-secret-prefs", ...extraEnv },
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error("Failed to start control plane:", error);
    cleanup(1);
  });
  procs.push(child);
  await waitForHttp(`http://localhost:${port}/healthz`);
  return port;
}

async function waitForHttp(url: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch {
      // not ready yet
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function req(port: number, method: string, pathname: string, body: unknown, token?: string) {
  const res = await fetch(`http://localhost:${port}${pathname}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

function expect(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    cleanup(1);
  }
  console.log(`✓ ${msg}`);
}

async function main() {
  const port = await startControlPlane({ ENFORCE_ENTITLEMENTS: "0" });

  // Unauthenticated read is refused.
  const noAuth = await req(port, "GET", "/api/push/preferences", undefined);
  expect(noAuth.status === 401, `unauthenticated GET is refused (got ${noAuth.status})`);

  const login = await req(port, "POST", "/auth/dev-login", { email: "prefs@example.com" });
  const token = login.json.token;

  // Fresh account: all six kinds default enabled.
  const defaults = await req(port, "GET", "/api/push/preferences", undefined, token);
  const dp = defaults.json?.preferences ?? {};
  expect(defaults.status === 200, `GET returns 200 (got ${defaults.status})`);
  expect(KINDS.every((k) => dp[k] === true), "defaults: all six kinds enabled");
  expect(Object.keys(dp).length === 6, `defaults: exactly six kinds (got ${Object.keys(dp).length})`);

  // Partial patch merges; unknown keys ignored.
  const put = await req(port, "PUT", "/api/push/preferences", { session_done: false, bogus: true }, token);
  const pp = put.json?.preferences ?? {};
  expect(put.status === 200, `PUT returns 200 (got ${put.status})`);
  expect(pp.session_done === false, "patch: session_done disabled");
  expect(pp.question_asked === true, "patch: untouched kinds stay enabled");
  expect(!("bogus" in pp), "patch: unknown key is ignored");

  // Second partial patch keeps the first change.
  const put2 = await req(port, "PUT", "/api/push/preferences", { terminal_bell: false }, token);
  const pp2 = put2.json?.preferences ?? {};
  expect(pp2.session_done === false && pp2.terminal_bell === false, "second patch merges without clobbering the first");

  // Persisted across a fresh GET.
  const after = await req(port, "GET", "/api/push/preferences", undefined, token);
  const ap = after.json?.preferences ?? {};
  expect(ap.session_done === false && ap.terminal_bell === false && ap.question_asked === true, "preferences persist across requests");

  console.log("\nAll notification-preferences checks passed.");
  cleanup(0);
}

main().catch((error) => {
  console.error(error);
  cleanup(1);
});
