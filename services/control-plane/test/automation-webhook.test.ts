// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

const cpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const procs: ChildProcess[] = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function finish(code: number): never {
  for (const proc of procs) proc.kill("SIGTERM");
  process.exit(code);
}
function expect(condition: boolean, message: string) {
  if (!condition) {
    console.error(`✗ FAIL: ${message}`);
    finish(1);
  }
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
async function trigger(port: number, endpoint: string, secret: string, raw: string, key: string) {
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  const response = await fetch(endpoint.replace(/^https?:\/\/[^/]+/, `http://localhost:${port}`), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bivy-signature-256": `sha256=${signature}`,
      "x-bivy-idempotency-key": key,
    },
    body: raw,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
}

async function main() {
  const port = await freePort();
  const proc = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: cpDir,
    env: { ...process.env, PORT: String(port), RELAY_SECRET: "automation-test", ENFORCE_ENTITLEMENTS: "0" },
    stdio: "inherit",
  });
  procs.push(proc);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/healthz`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  if (!ready) throw new Error("Control plane did not start");
  const login = await json(port, "POST", "/auth/dev-login", { email: "automation@example.com" });
  const token = login.body.token;
  const created = await json(port, "POST", "/account/automation-hooks", {
    templateInstruction: "Investigate this event safely.",
    routingDefault: "runner",
  }, token);
  expect(created.status === 201 && created.body.secret, "hook creation discloses a signing secret");

  const raw = JSON.stringify({ version: "1", instruction: "Run the tests", title: "CI failed", metadata: { branch: "main" } });
  const accepted = await trigger(port, created.body.endpoint, created.body.secret, raw, "delivery-1");
  expect(accepted.status === 202 && accepted.body.code === "accepted", "a correctly signed event is accepted");
  const duplicate = await trigger(port, created.body.endpoint, created.body.secret, raw, "delivery-1");
  expect(duplicate.status === 200 && duplicate.body.code === "duplicate", "redelivery is reported as a duplicate");
  const listed = await json(port, "GET", "/account/work-items", undefined, token);
  expect(listed.body.filter((item: any) => item.source.startsWith("automation:")).length === 1, "redelivery creates exactly one queued run");

  const bad = await trigger(port, created.body.endpoint, "wrong", raw, "delivery-2");
  expect(bad.status === 401 && bad.body.code === "invalid_signature", "invalid signatures are rejected");
  const afterBad = await json(port, "GET", "/account/work-items", undefined, token);
  expect(afterBad.body.length === listed.body.length, "invalid signatures persist nothing");

  const oversized = await trigger(port, created.body.endpoint, created.body.secret, "x".repeat(70_000), "delivery-3");
  expect(oversized.status === 413 && oversized.body.code === "payload_too_large", "oversized bodies receive a stable rejection");

  const rotated = await json(port, "POST", `/account/automation-hooks/${created.body.id}/rotate`, undefined, token);
  const oldSecret = await trigger(port, created.body.endpoint, created.body.secret, raw, "delivery-4");
  expect(oldSecret.status === 401, "rotation invalidates the old secret");
  const newSecret = await trigger(port, created.body.endpoint, rotated.body.secret, raw, "delivery-4");
  expect(newSecret.status === 202, "the rotated secret signs new deliveries");

  await json(port, "DELETE", `/account/automation-hooks/${created.body.id}`, undefined, token);
  const disabled = await trigger(port, created.body.endpoint, rotated.body.secret, raw, "delivery-5");
  expect(disabled.status === 410 && disabled.body.code === "disabled", "revoked hooks return the stable disabled result");
  console.log("\nAll automation webhook checks passed.");
  finish(0);
}

main().catch((error) => {
  console.error(error);
  finish(1);
});
