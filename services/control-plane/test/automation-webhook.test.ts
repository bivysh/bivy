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

  // --- Automations as code: a node can reconcile only definitions encrypted
  //     for itself; stable configKey updates rather than duplicates. ---
  const enrollment = await json(port, "POST", "/nodes/enroll", { nodeId: "node-as-code", name: "config-runner" }, token);
  const nodeToken = enrollment.body.enrollmentToken;
  expect(Boolean(nodeToken), "an enrolled node receives a token for automation reconciliation");
  const managedInput = {
    configKey: "managed-ci",
    configOrder: 0,
    name: "Managed CI",
    enabled: true,
    trigger: "manual",
    templateCiphertext: "bivy-room-v1:node-as-code:opaque",
    nodeLabel: "bivy/config-runner",
    approvalMode: "risky",
    sandbox: "workspace-write",
    maxAttempts: 2,
  };
  const managed = await json(port, "PUT", "/node/automation-config/managed-ci", managedInput, nodeToken);
  expect(managed.status === 201 && managed.body.configKey === "managed-ci", "node apply creates a source-controlled automation");
  const managedUpdate = await json(port, "PUT", "/node/automation-config/managed-ci", { ...managedInput, name: "Managed CI updated" }, nodeToken);
  expect(managedUpdate.status === 200 && managedUpdate.body.id === managed.body.id, "re-applying a config key updates instead of duplicating");
  const managedList = await json(port, "GET", "/node/automation-config", undefined, nodeToken);
  expect(managedList.body.automations.filter((d: any) => d.configKey === "managed-ci").length === 1, "managed definitions list by stable config key");
  const cliList = await json(port, "GET", "/node/automations", undefined, nodeToken);
  expect(cliList.status === 200 && cliList.body.automations.some((d: any) => d.id === managed.body.id), "an enrolled node can list account automations for the CLI");
  const unauthorizedCliList = await json(port, "GET", "/node/automations");
  expect(unauthorizedCliList.status === 401, "listing automations requires node authentication");
  const pwaEdit = await json(port, "PUT", `/account/automations/${managed.body.id}`, { name: "UI overwrite" }, token);
  expect(pwaEdit.status === 409, "the account/PWA API cannot overwrite a file-managed automation");
  const pwaDelete = await json(port, "DELETE", `/account/automations/${managed.body.id}`, undefined, token);
  expect(pwaDelete.status === 409, "the account/PWA API cannot delete a file-managed automation");
  const wrongNode = await json(port, "PUT", "/node/automation-config/wrong-node", { ...managedInput, configKey: "wrong-node", templateCiphertext: "bivy-room-v1:somebody-else:opaque" }, nodeToken);
  expect(wrongNode.status === 400, "a node cannot apply instructions encrypted for another node");
  const managedRun = await json(port, "POST", `/account/automations/${managed.body.id}/run`, undefined, token);
  expect(managedRun.status === 201, "a managed automation can be dispatched normally");
  const cliRun = await json(port, "POST", `/node/automations/${managed.body.id}/run`, undefined, nodeToken);
  expect(cliRun.status === 201 && cliRun.body.definitionId === managed.body.id, "an enrolled node can trigger an automation for the CLI");
  const unauthorizedCliRun = await json(port, "POST", `/node/automations/${managed.body.id}/run`);
  expect(unauthorizedCliRun.status === 401, "triggering an automation requires node authentication");
  const managedWork = await json(port, "GET", "/account/work-items", undefined, token);
  expect(managedWork.body.find((w: any) => w.id === managedRun.body.id)?.maxAttempts === 2, "managed run inherits its hard attempt ceiling");

  // --- One-off Runs: CLI/node and PWA/account paths create queue work without
  //     leaving an Automation definition behind. ---
  const oneOffCliRun = await json(port, "POST", "/node/automation-runs", {
    title: "Inspect flaky tests",
    body: "bivy-room-v1:node-as-code:opaque-one-off",
    repo: "acme/api",
    runtimeId: "pi",
    maxAttempts: 3,
  }, nodeToken);
  expect(oneOffCliRun.status === 201 && !oneOffCliRun.body.definitionId, "node API creates a definition-free one-off Run");
  const wrongCipherRun = await json(port, "POST", "/node/automation-runs", { title: "No", body: "plaintext" }, nodeToken);
  expect(wrongCipherRun.status === 400, "node API rejects plaintext one-off instructions");
  const appRun = await json(port, "POST", "/account/automation-runs", {
    title: "Update docs",
    body: "bivy-room-v1:node-as-code:opaque-app-run",
    label: "bivy/config-runner",
    sandbox: "read-only",
  }, token);
  expect(appRun.status === 201 && appRun.body.triggerKind === "manual" && !appRun.body.definitionId, "account API creates a manual one-off Run");
  const oneOffWork = await json(port, "GET", "/account/work-items", undefined, token);
  const cliWork = oneOffWork.body.find((w: any) => w.id === oneOffCliRun.body.id);
  const pendingNodeWork = await json(port, "GET", "/node/work?labels=bivy%2Fconfig-runner", undefined, nodeToken);
  const privateCliWork = pendingNodeWork.body.items.find((w: any) => w.id === oneOffCliRun.body.id);
  expect(cliWork?.repo === "acme/api" && cliWork?.maxAttempts === 3 && privateCliWork?.body === "bivy-room-v1:node-as-code:opaque-one-off", "one-off Run preserves encrypted instructions and bounded routing");

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

  const oversized = await trigger(port, auto.body.webhookUrl, auto.body.webhookSecret, "x".repeat(70_000), "evt-oversized");
  expect(oversized.status === 413 && oversized.body.code === "payload_too_large", "oversized bodies receive a stable rejection");

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
