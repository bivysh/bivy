// SPDX-License-Identifier: AGPL-3.0-only
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

  // --- Webhook-triggered automation *definition* (runs the operator's own
  //     pre-configured routing/agent/model/sandbox + E2E template) ---
  const auto = await json(port, "POST", "/account/automations", {
    name: "Fix CI",
    trigger: "webhook",
    templateCiphertext: "bivy-room-v1:node-x:opaque",
    nodeLabel: "bivy/runner",
    sandbox: "workspace-write",
    repo: "acme/api",
  }, token);
  expect(auto.status === 201 && auto.body.webhookSecret && auto.body.webhookUrl, "a webhook automation discloses a secret and URL at create");
  expect(auto.body.trigger === "webhook" && !auto.body.nextRunAt, "a webhook automation is never scheduled");
  expect(auto.body.repo === "acme/api", "create echoes the workspace repo");

  const listAuto = await json(port, "GET", "/account/automations", undefined, token);
  const listedAuto = listAuto.body.find((d: any) => d.id === auto.body.id);
  expect(listedAuto && !listedAuto.webhookSecret && listedAuto.webhookUrl, "listing shows the URL but never echoes the secret");
  expect(listedAuto.repo === "acme/api", "listing preserves the workspace repo");

  const evtRaw = JSON.stringify({ version: "1", instruction: "Build 8841 failed", title: "CI", metadata: { job: "linux" } });
  const fired = await trigger(port, auto.body.webhookUrl, auto.body.webhookSecret, evtRaw, "evt-1");
  expect(fired.status === 202 && fired.body.code === "accepted", "a signed event fires the configured automation");
  const dupFired = await trigger(port, auto.body.webhookUrl, auto.body.webhookSecret, evtRaw, "evt-1");
  expect(dupFired.status === 200 && dupFired.body.code === "duplicate", "webhook redelivery to a definition is idempotent");

  const runs = await json(port, "GET", "/account/work-items", undefined, token);
  const defRun = runs.body.find((it: any) => it.definitionId === auto.body.id);
  expect(!!defRun, "the run is bound to the automation definition");
  expect(defRun.triggerKind === "webhook", "the run records a webhook trigger");
  expect(String(defRun.label).includes("runner"), "the run inherits the definition's node routing");
  expect(defRun.sandbox === "workspace-write", "the run inherits the definition's sandbox (payload cannot override it)");
  expect(defRun.repo === "acme/api", "the run inherits the definition's workspace repo");

  // Event-supplied repo fills in when the definition left workspace open.
  const openWs = await json(port, "POST", "/account/automations", {
    name: "Open workspace",
    trigger: "webhook",
    templateCiphertext: "bivy-room-v1:node-x:opaque",
    nodeLabel: "bivy/runner",
  }, token);
  expect(openWs.status === 201, "automation without a repo is allowed");
  const evtWithRepo = JSON.stringify({ version: "1", instruction: "look here", repo: "acme/other" });
  const firedRepo = await trigger(port, openWs.body.webhookUrl, openWs.body.webhookSecret, evtWithRepo, "evt-repo-1");
  expect(firedRepo.status === 202, "event repo is accepted");
  const runs2 = await json(port, "GET", "/account/work-items", undefined, token);
  const openRun = runs2.body.find((it: any) => it.definitionId === openWs.body.id);
  expect(openRun?.repo === "acme/other", "event repo becomes the run workspace when definition has none");

  const badSig = await trigger(port, auto.body.webhookUrl, "nope", evtRaw, "evt-2");
  expect(badSig.status === 401, "a bad signature is rejected on the definition path");

  const rot = await json(port, "POST", `/account/automations/${auto.body.id}/webhook/rotate`, undefined, token);
  expect(rot.status === 200 && rot.body.webhookSecret && rot.body.webhookSecret !== auto.body.webhookSecret, "rotate returns a fresh secret");
  const oldSig = await trigger(port, auto.body.webhookUrl, auto.body.webhookSecret, evtRaw, "evt-3");
  expect(oldSig.status === 401, "the old secret stops working after rotate");
  const newSig = await trigger(port, auto.body.webhookUrl, rot.body.webhookSecret, evtRaw, "evt-3");
  expect(newSig.status === 202, "the rotated secret signs new deliveries");

  await json(port, "PUT", `/account/automations/${auto.body.id}`, { enabled: false }, token);
  const whenDisabled = await trigger(port, auto.body.webhookUrl, rot.body.webhookSecret, evtRaw, "evt-4");
  expect(whenDisabled.status === 410 && whenDisabled.body.code === "disabled", "a disabled webhook automation refuses events");

  console.log("\nAll automation webhook checks passed.");
  finish(0);
}

main().catch((error) => {
  console.error(error);
  finish(1);
});
