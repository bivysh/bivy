// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import type { ChildProcess } from "node:child_process";
import { spawnTestService, stopTestServices } from "../../test-service-process.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { createHash } from "node:crypto";

/**
 * The account's cloud computer when the deployment extension runs one sleeping
 * machine per account: the real control plane against a fake extension.
 */

const cpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const procs: ChildProcess[] = [];
const EXTENSION_TOKEN = "test-extension-token";

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

async function waitFor(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
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
  if (!cond) throw new Error(`✗ FAIL: ${msg}`);
  console.log(`✓ ${msg}`);
}

async function main() {
  // Fake extension: one machine per account; records what Core asked for.
  const calls: Array<{ path: string; body: any }> = [];
  let deny = false;
  let acquireDelayMs = 0;
  const extension = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: request.url ?? "", body });
      const nodeId = body.subject?.accountId ? `eph-managed-auto-${createHash("sha256").update(body.subject.accountId).digest("hex").slice(0, 16)}` : "";
      const answers: Record<string, unknown> = {
        "/v1/compute/profile": { profile: { provider: "fly", image: "runner:test", ttlMinutes: 60, accountMachine: true, runners: true } },
        "/v1/compute/acquire": deny ? { allowed: false, code: "trial_exhausted", reason: "Trial used up." } : { nodeId, state: "launching" },
        "/v1/compute/wake": { state: "waking" },
        "/v1/compute/machines": { machines: [
          { id: "fly-1", nodeId, provider: "fly", region: "iad", state: "asleep", createdAt: "2026-10-06T00:00:00Z" },
          { id: "fly-r", nodeId: "eph-runner-0123456789abcdef", provider: "fly", kind: "runner", state: "asleep", deleteAt: "2026-11-03T12:00:00.000Z", createdAt: "2026-10-27T00:00:00Z" },
          { id: "fly-x", nodeId: "eph-runner-fedcba9876543210", provider: "fly", kind: "runner", state: "asleep", deleteAt: "soon", createdAt: "2026-10-27T00:00:00Z" },
        ] },
        "/v1/compute/release": { released: true },
        "/v1/compute/pool-key": { publicKey: "pool-pub" },
        "/v1/compute/pool-key/delete": { deleted: true },
        "/v1/compute/runners/release": { released: true },
        "/v1/compute/runners/wake": { state: "waking" },
        "/v1/compute/runners/launch": { nodeId: body.runnerId ? `eph-runner-${createHash("sha256").update(`${body.subject?.accountId}:${body.runnerId}`).digest("hex").slice(0, 16)}` : "", state: "launching" },
        "/v1/policy/check": { allowed: true },
        "/v1/account": { presentation: {} },
      };
      response.setHeader("content-type", "application/json");
      const delay = request.url === "/v1/compute/acquire" ? acquireDelayMs : 0;
      setTimeout(() => response.end(JSON.stringify(answers[request.url ?? ""] ?? {})), delay);
    });
  });
  await new Promise<void>((resolve) => extension.listen(0, "127.0.0.1", resolve));
  extension.unref();
  const port = await freePort();
  procs.push(spawnTestService(cpDir, {
    PORT: String(port),
    RELAY_SECRET: "test-secret-cc",
    HOSTED_CREDENTIAL_KEY: Buffer.alloc(32, 5).toString("base64"),
    EPHEMERAL_MACHINES_ENABLED: "1",
    DEPLOYMENT_EXTENSION_URL: `http://127.0.0.1:${(extension.address() as net.AddressInfo).port}`,
    DEPLOYMENT_EXTENSION_TOKEN: EXTENSION_TOKEN,
  }));
  await waitFor(async () => (await fetch(`http://localhost:${port}/healthz`).catch(() => null))?.ok === true, "control plane");

  const login = await req(port, "POST", "/auth/dev-login", { email: "cloud-computer@example.com" });
  const token = login.json.token;
  const accountId = login.json.account.id;
  const nodeId = `eph-managed-auto-${createHash("sha256").update(accountId).digest("hex").slice(0, 16)}`;

  // Boot payload: only the extension may ask; it re-enrolls the stable node.
  expect((await req(port, "POST", "/internal/compute/bootstrap", { accountId })).status === 401, "the boot payload requires the extension's token");
  // A rebuild request for a session with no snapshot is ignored.
  const boot = await req(port, "POST", "/internal/compute/bootstrap", { accountId, awakeCapMinutes: 360, restoreSessionId: "s-old" }, EXTENSION_TOKEN);
  expect(boot.status === 200 && boot.json?.nodeId === nodeId, "the cloud computer boots as the account's stable node");
  let relay = JSON.parse(Buffer.from(boot.json.files.find((f: { guest_path: string }) => f.guest_path === "/etc/bivy/relay.json").raw_value, "base64").toString("utf8"));
  const start = Buffer.from(boot.json.files.find((f: { guest_path: string }) => f.guest_path === "/etc/bivy/start.sh").raw_value, "base64").toString("utf8");
  expect(typeof relay.enrollmentToken === "string" && relay.enrollmentToken.startsWith("enr_"), "the payload carries a fresh enrollment token");
  expect(!("e2eKey" in relay), "the payload carries no room key: the machine generates its own");
  expect(relay.nodeId === nodeId, "the payload names the id the machine was enrolled as, so it answers to it");
  expect(!/BIVY_HOSTED_CREDENTIAL|BIVY_RESTORE/.test(start), "the machine is no credential-custody guest and rebuilds nothing from snapshots");
  expect(/BIVY_EPHEMERAL_SLEEP=1/.test(start) && /BIVY_DATA_DIR=\/data\/bivy/.test(start), "the node sleeps instead of being destroyed, with its state on the volume");
  expect(boot.json.init.exec.includes("21600"), "each awake period is bounded by the awake cap");
  // A new disk restores a session whose snapshot is sealed to the account (any
  // of the account's machines can open it), but not one sealed to the old
  // machine's own key.
  const nodeToken = relay.enrollmentToken;
  await req(port, "PUT", "/node/session-snapshot/s-account", { ciphertext: "bivy-acct-v1:0123456789abcdef:opaque" }, nodeToken);
  await req(port, "PUT", "/node/session-snapshot/s-machine", { ciphertext: "opaque-room-key-seal" }, nodeToken);
  const startOf = (payload: { json: { files: Array<{ guest_path: string; raw_value: string }> } }) =>
    Buffer.from(payload.json.files.find((f) => f.guest_path === "/etc/bivy/start.sh")!.raw_value, "base64").toString("utf8");
  const restoring = await req(port, "POST", "/internal/compute/bootstrap", { accountId, restoreSessionId: "s-account" }, EXTENSION_TOKEN);
  expect(/BIVY_RESTORE='?s-account/.test(startOf(restoring)), "a new disk restores an account-sealed session");
  const machineSealed = await req(port, "POST", "/internal/compute/bootstrap", { accountId, restoreSessionId: "s-machine" }, EXTENSION_TOKEN);
  expect(!/BIVY_RESTORE/.test(startOf(machineSealed)), "a snapshot only the old disk could open is not restored");
  // Each boot re-enrolls the node; carry on with the newest token.
  relay = JSON.parse(Buffer.from(machineSealed.json.files.find((f: { guest_path: string }) => f.guest_path === "/etc/bivy/relay.json").raw_value, "base64").toString("utf8"));
  const enrolled = await req(port, "GET", "/nodes", undefined, token);
  expect((enrolled.json ?? []).some((n: { id: string; online: boolean }) => n.id === nodeId && !n.online), "the enrolled node is listed, asleep");

  // Deletion notice: the fleet knows when, Core knows how to reach the person.
  // This deployment has no email sender, and must say so rather than let the
  // fleet wait forever on a warning that will never arrive.
  const notice = await req(port, "POST", "/internal/compute/notice", { accountId, kind: "computer", deleteAt: new Date(Date.now() + 86_400_000).toISOString() }, EXTENSION_TOKEN);
  expect(notice.status === 200 && notice.json?.notified === false, "an unsendable deletion notice is reported as unsent, not as an error");
  const undated = await req(port, "POST", "/internal/compute/notice", { accountId, kind: "computer" }, EXTENSION_TOKEN);
  expect(undated.status === 400, "a notice without a deletion date is refused");

  // Launch returns the cloud computer and no key: devices pair with it.
  const configs = await req(port, "GET", "/account/ephemeral-configs", undefined, token);
  const cloud = configs.json?.find((c: { computeSource?: string }) => c.computeSource === "managed");
  const first = await req(port, "POST", "/account/managed-machines", { configId: cloud.id, runtimeId: "claude-code-sdk", requestId: "r1" }, token);
  const second = await req(port, "POST", "/account/managed-machines", { configId: cloud.id, requestId: "r2" }, token);
  expect(first.status === 201 && first.json?.machine?.nodeId === nodeId && second.json?.machine?.nodeId === nodeId, "launching asks the extension for the account's cloud computer");
  expect(!("roomKey" in first.json) && !("roomKey" in second.json), "a launch hands out no room key");
  const target = await req(port, "POST", "/account/managed-automation-target", undefined, token);
  expect(target.json?.nodeId === nodeId && !("roomKey" in target.json), "the automation target names the node and hands out no key");
  for (const [method, path] of [["GET", "/node/model-auth-hosted-vault"], ["PUT", "/node/model-auth-hosted-vault"], ["PUT", "/node/model-auth-key/hosted-escrow"]] as const) {
    expect((await req(port, method, path, method === "PUT" ? { vaultKeyB64: Buffer.alloc(32).toString("base64"), ciphertext: "x", expectedGeneration: 0, revision: 0 } : undefined, relay.enrollmentToken)).status === 404, `${method} ${path} no longer exists: the control plane holds no credential key`);
  }
  expect(calls.some((c) => c.path === "/v1/compute/acquire" && c.body.purpose === "interactive" && c.body.runtimeId === "claude-code-sdk"), "the extension learns the purpose and agent");
  acquireDelayMs = 6_000;
  const slow = await req(port, "POST", "/account/managed-machines", { configId: cloud.id, requestId: "r-slow" }, token);
  expect(slow.status === 201, "a launch that takes the provider longer than a policy call still succeeds");
  acquireDelayMs = 0;
  deny = true;
  const denied = await req(port, "POST", "/account/managed-machines", { configId: cloud.id, requestId: "r3" }, token);
  expect(denied.status === 403 && denied.json?.code === "trial_exhausted", "a refusal returns the deployment's decision");
  deny = false;

  // Cloud Runner: a new runner for one session, offered when the deployment runs runners.
  expect(cloud.runners === true, "the managed profile says the deployment can start a runner per session");
  const sessionRunner = await req(port, "POST", "/account/managed-machines", { configId: "managed-runner", requestId: "draft-1" }, token);
  const sessionRunnerNode = sessionRunner.json?.machine?.nodeId as string;
  expect(sessionRunner.status === 201 && /^eph-runner-/.test(sessionRunnerNode) && sessionRunner.json?.machine?.name === "Cloud Runner", "picking Cloud Runner starts a runner, not the cloud computer");
  expect(calls.some((c) => c.path === "/v1/compute/runners/launch" && c.body.runnerId === "session:draft-1" && c.body.sleeps === true), "the runner is for this session, and sleeps between uses");
  const sessionBoot = await req(port, "POST", "/internal/compute/runner-bootstrap", { accountId, runnerId: "session:draft-1" }, EXTENSION_TOKEN);
  const sessionStart = Buffer.from(sessionBoot.json.files.find((f: { guest_path: string }) => f.guest_path === "/etc/bivy/start.sh").raw_value, "base64").toString("utf8");
  expect(sessionBoot.json?.nodeId === sessionRunnerNode && !/BIVY_TEARDOWN_ON_FINISH/.test(sessionStart), "a session's runner waits for follow-ups instead of ending after the first turn");
  expect(/BIVY_EPHEMERAL_SLEEP=1/.test(sessionStart) && /BIVY_DATA_DIR=\/data\/bivy/.test(sessionStart), "it sleeps when idle, with its sessions on its own disk");
  const sessionRelay = JSON.parse(Buffer.from(sessionBoot.json.files.find((f: { guest_path: string }) => f.guest_path === "/etc/bivy/relay.json").raw_value, "base64").toString("utf8"));
  const runnerMilestone = await req(port, "POST", "/node/ephemeral-milestone", { milestone: "credentialsReadyAt" }, sessionRelay.enrollmentToken);
  expect(runnerMilestone.json?.tracked === true, "a runner's milestones are tracked, so its launch sees credentials ready");
  const resumed = await req(port, "POST", "/account/managed-machines/restore", { sessionId: "s-on-runner", nodeId: sessionRunnerNode, configId: "managed-runner" }, token);
  expect(resumed.status === 201 && resumed.json?.machine?.nodeId === sessionRunnerNode, "sending to a sleeping session runner wakes it");
  expect(calls.some((c) => c.path === "/v1/compute/runners/wake" && c.body.nodeId === sessionRunnerNode), "the deployment is asked to wake that runner");
  const wakesBefore = calls.filter((c) => c.path === "/v1/compute/runners/wake").length;
  await req(port, "POST", "/client/relay-ticket", { nodeId: sessionRunnerNode }, token);
  await waitFor(() => calls.filter((c) => c.path === "/v1/compute/runners/wake").length > wakesBefore, "runner wake on connect");
  console.log("✓ connecting to a sleeping session runner wakes it");
  const otherLogin = await req(port, "POST", "/auth/dev-login", { email: "someone-else@example.com" });
  const foreign = await req(port, "POST", "/account/managed-machines/restore", { sessionId: "s", nodeId: sessionRunnerNode, configId: "managed-runner" }, otherLogin.json.token);
  expect(foreign.status === 404, "nobody can wake another account's runner");

  // Connecting to the sleeping node wakes it.
  const ticket = await req(port, "POST", "/client/relay-ticket", { nodeId }, token);
  expect(ticket.status === 200, "a client can still get a relay ticket for a sleeping node");
  await waitFor(() => calls.some((c) => c.path === "/v1/compute/wake" && c.body.nodeId === nodeId), "wake on connect");
  console.log("✓ connecting to a sleeping cloud computer wakes it");
  expect(calls.find((c) => c.path === "/v1/compute/wake")?.body.reason === "connect", "a connection wake says so");

  // Being in the app wakes it too, before any connection, and says why.
  expect((await req(port, "POST", "/account/cloud-computer/presence", { reason: "typing" }, token)).status === 400, "only known presence reasons are accepted");
  const present = await req(port, "POST", "/account/cloud-computer/presence", { reason: "composer" }, token);
  expect(present.status === 200 && present.json?.waking === true, "presence in the app wakes a sleeping cloud computer");
  await waitFor(() => calls.some((c) => c.path === "/v1/compute/wake" && c.body.reason === "composer"), "presence wake");

  // Opening a preview link for it wakes it too (asked by the relay).
  const route = createHash("sha256").update(nodeId).digest("hex").slice(0, 24);
  expect((await req(port, "POST", "/internal/preview-wake", { route })).status === 401, "only the relay may wake a node from a preview");
  const previewWake = await req(port, "POST", "/internal/preview-wake", { route }, "test-secret-cc");
  expect(previewWake.json?.waking === true, "a preview link for a sleeping cloud computer starts it");
  await waitFor(() => calls.some((c) => c.path === "/v1/compute/wake" && c.body.reason === "preview"), "wake on preview");
  const unknown = await req(port, "POST", "/internal/preview-wake", { route: "0".repeat(24) }, "test-secret-cc");
  expect(unknown.json?.waking === false, "a preview for any other node wakes nothing");

  // The node reports this boot's milestones; the launch reads them back.
  const reported = await req(port, "POST", "/node/ephemeral-milestone", { milestone: "credentialsReadyAt" }, relay.enrollmentToken);
  expect(reported.status === 200, "the cloud computer reports its milestones");
  expect(!calls.some((c) => c.path === "/v1/compute/used"), "being up is not being used");
  await req(port, "POST", "/node/ephemeral-milestone", { milestone: "firstUseAt" }, relay.enrollmentToken);
  await waitFor(() => calls.some((c) => c.path === "/v1/compute/used" && c.body.nodeId === nodeId && typeof c.body.at === "string"), "used event");
  console.log("✓ the first real use tells the deployment the computer is in use");
  const withMilestones = await req(port, "GET", "/account/hosted-machines", undefined, token);
  expect(typeof withMilestones.json?.[0]?.milestones?.credentialsReadyAt === "string", "the launch sees credentials ready for this boot");
  await req(port, "POST", "/account/managed-machines", { configId: cloud.id, requestId: "r4" }, token);
  const afterStart = await req(port, "GET", "/account/hosted-machines", undefined, token);
  expect(!afterStart.json?.[0]?.milestones?.credentialsReadyAt, "starting the machine again forgets the previous boot's milestones");

  // Inventory and release go through the extension.
  const machines = await req(port, "GET", "/account/hosted-machines", undefined, token);
  expect(machines.json?.[0]?.nodeId === nodeId && machines.json?.[0]?.lifecycleState === "asleep", "the hosted-machines panel shows the extension's machine");
  expect(machines.json?.[1]?.kind === "runner" && machines.json?.[1]?.deleteAt === "2026-11-03T12:00:00.000Z", "a sleeping runner says when it will be deleted");
  expect(machines.json?.[2]?.deleteAt === undefined, "only a real date is passed on");
  const released = await req(port, "DELETE", `/account/hosted-machines/${nodeId}`, undefined, token);
  expect(released.status === 200, "release destroys the cloud computer through the extension");

  // Handoff: the cloud computer moves work sealed to it onto a runner, with the
  // instructions re-sealed for that runner. Nobody else may.
  expect(/BIVY_HANDOFF_TO_RUNNERS=1/.test(start), "a cloud computer whose deployment runs runners hands work to them");
  const sealedRun = await req(port, "POST", "/node/automation-runs", { title: "nightly", body: `bivy-room-v1:${nodeId}:abc`, node: "Bivy Cloud" }, relay.enrollmentToken);
  const itemId = (sealedRun.json?.id ?? sealedRun.json?.run?.id) as string;
  expect(sealedRun.status < 300 && typeof itemId === "string", "work sealed to the cloud computer is queued");
  const asked = await req(port, "POST", "/node/runners", { itemId }, relay.enrollmentToken);
  const handTo = asked.json?.nodeId as string;
  expect(asked.status === 200 && /^eph-runner-/.test(handTo), "the cloud computer gets a runner for it");
  expect((await req(port, "POST", `/node/work/${itemId}/handoff`, { nodeId: handTo, body: `bivy-room-v1:${nodeId}:abc` }, relay.enrollmentToken)).status === 400, "instructions must be re-sealed for the runner");
  const moved = await req(port, "POST", `/node/work/${itemId}/handoff`, { nodeId: handTo, body: `bivy-room-v1:${handTo}:def` }, relay.enrollmentToken);
  expect(moved.status === 200 && moved.json?.label === `bivy/${handTo.replace(/^eph-/, "")}`, "the item moves to the runner's label");
  expect((await req(port, "POST", `/node/work/${itemId}/handoff`, { nodeId: handTo, body: `bivy-room-v1:${handTo}:ghi` }, relay.enrollmentToken)).status === 409, "it can't be handed off twice");
  const laptopEnroll = await req(port, "POST", "/nodes/enroll", { nodeId: "node_laptop", name: "laptop" }, token);
  expect((await req(port, "POST", "/node/runners", { itemId }, laptopEnroll.json?.enrollmentToken)).status === 403, "only the cloud computer starts runners");

  // One machine refreshes a synced sign-in at a time: the lease has one holder
  // across the account's machines until that holder gives it up.
  const laptopToken = laptopEnroll.json?.enrollmentToken;
  const refreshKey = { key: "oauth-refresh:anthropic:default" };
  expect((await req(port, "POST", "/node/lease", refreshKey, relay.enrollmentToken)).json?.granted === true, "a machine takes the refresh lease");
  const contended = await req(port, "POST", "/node/lease", refreshKey, laptopToken);
  expect(contended.json?.granted === false && contended.json?.holder === nodeId, "another of the account's machines waits for it");
  await req(port, "DELETE", "/node/lease", refreshKey, relay.enrollmentToken);
  expect((await req(port, "POST", "/node/lease", refreshKey, laptopToken)).json?.granted === true, "once released, the next machine gets it");
  expect((await req(port, "POST", "/node/lease", { key: "anything-else" }, laptopToken)).status === 400, "only known lease kinds can be taken");

  // "Cloud machines can start with my sign-ins": off by default; on, the
  // account's machines wrap the vault key to the deployment's pool key and only
  // the deployment's own machines are handed that wrap.
  expect((await req(port, "GET", "/account/cloud-sign-ins", undefined, token)).json?.enabled === false, "cloud sign-ins are off until the account turns them on");
  expect((await req(port, "PUT", "/account/cloud-sign-ins", { enabled: true }, token)).json?.enabled === true, "the account turns them on");
  await req(port, "PUT", "/node/model-auth-vault", { ciphertext: "vault-ct" }, laptopToken);
  const holder = await req(port, "GET", "/node/model-auth-vault", undefined, laptopToken);
  expect(holder.json?.poolKey?.publicKey === "pool-pub" && holder.json?.poolKey?.wrapped === false, "a machine holding the key learns the pool key needs a wrap");
  expect((await req(port, "PUT", "/node/model-auth-key/pool", { publicKey: "someone-else", wrappedKey: "w", wrappedByPublicKey: "laptop-pub" }, laptopToken)).status === 409, "a wrap for any other key is refused");
  await req(port, "PUT", "/node/model-auth-key/pool", { publicKey: "pool-pub", wrappedKey: "wrapped-for-pool", wrappedByPublicKey: "laptop-pub" }, laptopToken);
  expect((await req(port, "GET", "/node/model-auth-vault", undefined, relay.enrollmentToken)).json?.poolWrappedKey?.wrappedKey === "wrapped-for-pool", "the cloud computer is handed the pool wrap");
  expect(!(await req(port, "GET", "/node/model-auth-vault", undefined, laptopToken)).json?.poolWrappedKey, "the account's own machines aren't");
  await req(port, "PUT", "/account/cloud-sign-ins", { enabled: false }, token);
  const after = await req(port, "GET", "/node/model-auth-vault", undefined, laptopToken);
  expect(!after.json?.poolKey && after.json?.vault?.needsRotation === true, "turning it off forgets the pool key and re-keys the vault");
  expect(calls.some((c) => c.path === "/v1/compute/pool-key/delete"), "and the deployment deletes its keypair");

  // A runner: its own node for one piece of work, booted to work alone. It
  // sleeps when done, keeping the session, and is forgotten once the
  // deployment deletes it.
  const runnerBoot = await req(port, "POST", "/internal/compute/runner-bootstrap", { accountId, runnerId: "work:w1", awakeCapMinutes: 180 }, EXTENSION_TOKEN);
  const runnerId = runnerBoot.json?.nodeId as string;
  expect(runnerBoot.status === 200 && /^eph-runner-[0-9a-f]{16}$/.test(runnerId), "a runner boots as its own node");
  const runnerStart = Buffer.from(runnerBoot.json.files.find((f: { guest_path: string }) => f.guest_path === "/etc/bivy/start.sh").raw_value, "base64").toString("utf8");
  expect(/BIVY_WORK_OWN_LABEL_ONLY=1/.test(runnerStart) && /BIVY_OAUTH_REFRESH=0/.test(runnerStart), "it works only its own label and doesn't refresh sign-ins on its own");
  expect(/BIVY_EPHEMERAL_SLEEP=1/.test(runnerStart) && !/BIVY_TEARDOWN_ON_FINISH=1/.test(runnerStart), "it sleeps when the work is done instead of disappearing");
  expect(JSON.parse(Buffer.from(runnerBoot.json.files.find((f: { guest_path: string }) => f.guest_path === "/etc/bivy/relay.json").raw_value, "base64").toString("utf8")).nodeId === runnerId, "a runner answers to its enrolled id");
  const runnerRelay = JSON.parse(Buffer.from(runnerBoot.json.files.find((f: { guest_path: string }) => f.guest_path === "/etc/bivy/relay.json").raw_value, "base64").toString("utf8"));
  // A new machine asks for the vault key with none of the account's other
  // machines online: the sleeping cloud computer is woken to hand it over.
  await req(port, "POST", "/node/model-auth-key/request", { publicKey: "runner-pub" }, runnerRelay.enrollmentToken);
  await waitFor(() => calls.some((c) => c.path === "/v1/compute/wake" && c.body.reason === "key"), "home wake for the vault key");
  expect(true, "a machine waiting for the vault key wakes the account's cloud computer");
  expect((await req(port, "POST", "/node/settled", {}, runnerRelay.enrollmentToken)).status === 200, "a finished runner reports settled");
  await waitFor(() => calls.some((c) => c.path === "/v1/compute/runners/release" && c.body.nodeId === runnerId), "runner release");
  console.log("✓ a settled runner is released at once");
  expect((await req(port, "POST", "/internal/compute/retired", { accountId, nodeId: runnerId }, EXTENSION_TOKEN)).status === 200, "the deployment reports the runner gone");
  expect(!((await req(port, "GET", "/nodes", undefined, token)).json ?? []).some((n: { id: string }) => n.id === runnerId), "a retired runner's node is removed");
  expect((await req(port, "PUT", "/node/model-auth-key/wrapped", { targetNodeId: runnerId, wrappedKey: "k", wrappedByPublicKey: "p" }, relay.enrollmentToken)).status === 404, "a key wrapped for a machine that is gone is a 404, not a server error");
  expect(((await req(port, "GET", "/nodes", undefined, token)).json ?? []).some((n: { id: string }) => n.id === nodeId), "the cloud computer's node stays");

  console.log("\nAll cloud-computer HTTP checks passed.");
}

// Queued work: the routing decision, against the in-memory store.
async function routing() {
  process.env.HOSTED_CREDENTIAL_KEY = Buffer.alloc(32, 5).toString("base64");
  const { createPgMemStore } = await import("../src/pg-mem-store.js");
  const { routeWorkToCloudComputer, cloudComputerNodeId } = await import("../src/cloud-computer.js");
  const store = createPgMemStore();
  await store.init();
  const account = await store.findOrCreateAccount("routing@example.com");

  // Escrow left by an earlier version is deleted when the control plane starts
  // (`init` runs this purge).
  const query = (store as unknown as { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> }).query.bind(store);
  await query(`INSERT INTO node_room_keys (account_id, node_id, room_key_enc) VALUES ($1, $2, '{}')`, [account.id, cloudComputerNodeId(account.id)]);
  await query(`INSERT INTO hosted_model_auth_keys (account_id, key_enc, ciphertext) VALUES ($1, '{}', 'x')`, [account.id]);
  await store.purgeRetiredKeyEscrow();
  expect((await query(`SELECT 1 FROM node_room_keys`)).rows.length === 0, "startup deletes room keys the control plane minted");
  expect((await query(`SELECT 1 FROM hosted_model_auth_keys`)).rows.length === 0, "startup deletes escrowed credential vault keys");
  const cloud = { id: "managed-default", name: "Bivy Cloud", provider: "fly", computeSource: "managed" as const, createdAt: "", updatedAt: "" };
  await store.setEphemeralConfigs(account.id, [cloud]);
  const label = `bivy/${cloudComputerNodeId(account.id).replace(/^eph-/, "")}`;
  const item = await store.enqueueWorkItem(account.id, { source: "manual", title: "nightly" });
  expect(!(await routeWorkToCloudComputer(store, account.id)), "shared routing leaves work for the user's own machines");
  await store.setQueueRouting(account.id, { primary: { kind: "node", node: "laptop" }, fallback: { kind: "config", configId: cloud.id } });
  await store.enrollNode(account.id, "n-laptop", "laptop");
  await store.setNodeOnline("n-laptop", true);
  expect(!(await routeWorkToCloudComputer(store, account.id)), "an online primary machine keeps its work");
  await store.setNodeOnline("n-laptop", false);
  const laptopItem = await store.enqueueWorkItem(account.id, { source: "manual", title: "for laptop", label: "bivy/laptop" });
  expect(await routeWorkToCloudComputer(store, account.id), "an offline primary falls back to the cloud computer");
  const items = await store.listWorkItems(account.id, 10);
  expect(items.find((i) => i.id === laptopItem.id)?.label === label, "the waiting work moves to the cloud computer's label");
  expect(items.find((i) => i.id === item.id)?.label !== label, "work for another route is left alone");

  // Who may take queued work: cloud and runner labels are theirs alone, and
  // while routing sends the shared queue to the cloud, other machines leave it.
  const { nodeMayTakeWork } = await import("../src/cloud-computer.js");
  const computer = cloudComputerNodeId(account.id);
  const take = (nodeId: string, itemLabel: string, sharedGoesToCloud = false) => nodeMayTakeWork({ accountId: account.id, nodeId, label: itemLabel, sharedGoesToCloud });
  expect(!take("n-laptop", label) && take(computer, label), "only the cloud computer takes work on its label");
  expect(!take("n-laptop", "bivy/runner-0123456789abcdef") && !take(computer, "bivy/runner-0123456789abcdef") && take("eph-runner-0123456789abcdef", "bivy/runner-0123456789abcdef"), "only its runner takes work on a runner's label");
  expect(!take("n-laptop", "bivy", true) && take(computer, "bivy", true), "shared work routed to the cloud is left to the cloud computer");
  expect(take("n-laptop", "bivy") && take("n-laptop", "bivy/laptop"), "otherwise machines take shared and their own work as before");

  // Placement: work the cloud gets goes to its own runner when one is free.
  const { placeCloudWork, placeFor } = await import("../src/placement.js");
  const { runnerNodeId } = await import("../src/runners.js");
  const both = { computer: true, runners: true };
  await store.setQueueRouting(account.id, { primary: { kind: "config", configId: cloud.id } });
  const issue = await store.enqueueWorkItem(account.id, { source: "github:issue", title: "fix it", repo: "o/r", issueNumber: 7 });
  const launched: Array<[string, string | undefined]> = [];
  const actions = {
    launchRunner: async (runnerId: string, restore?: string) => { launched.push([runnerId, restore]); return { allowed: true }; },
    wakeRunner: async () => ({ allowed: true }),
  };
  expect(await placeCloudWork(store, account.id, issue.id, both, actions) === "new-runner", "cloud-routed work is placed on a runner");
  const runnerLabelFor = (id: string) => `bivy/${runnerNodeId(account.id, `work:${id}`).replace(/^eph-/, "")}`;
  expect(launched[0]?.[0] === `work:${issue.id}` && (await store.listWorkItems(account.id, 20)).find((i) => i.id === issue.id)?.label === runnerLabelFor(issue.id), "the item waits on that runner's own label");
  const busy = await store.enqueueWorkItem(account.id, { source: "github:issue", title: "another", repo: "o/r", issueNumber: 8 });
  expect(await placeCloudWork(store, account.id, busy.id, both, { ...actions, launchRunner: async () => ({ allowed: false }) }) === "computer", "no free runner: it falls back to the cloud computer");
  expect((await store.listWorkItems(account.id, 20)).find((i) => i.id === busy.id)?.label === "bivy", "a refused item goes back where it was");
  const busyAlone = await store.enqueueWorkItem(account.id, { source: "github:issue", title: "a third", repo: "o/r", issueNumber: 9 });
  expect(await placeCloudWork(store, account.id, busyAlone.id, { computer: false, runners: true }, { ...actions, launchRunner: async () => ({ allowed: false }) }) === "wait", "without a cloud computer it waits for the account's own machines");
  const sealed = await store.enqueueWorkItem(account.id, { source: "manual", title: "nightly", body: `bivy-room-v1:${cloudComputerNodeId(account.id)}:abc` });
  expect(await placeCloudWork(store, account.id, sealed.id, both, { launchRunner: async () => { throw new Error("must not launch"); }, wakeRunner: async () => { throw new Error("must not wake"); } }) === "computer", "work sealed to the cloud computer stays with it");

  // A follow-up on a session whose runner is gone restores it on a new runner,
  // given a snapshot sealed to the account.
  await store.setSessionSnapshot(account.id, "s-follow", "bivy-acct-v1:0123456789abcdef:opaque");
  const followUp = await store.enqueueWorkItem(account.id, { source: "github:comment", title: "follow-up", repo: "o/r", issueNumber: 7, target: { kind: "existing_session", sessionId: "s-follow" } });
  launched.length = 0;
  expect(await placeCloudWork(store, account.id, followUp.id, both, actions) === "new-runner" && launched[0]?.[1] === "s-follow", "a follow-up whose machine is gone restores its session on a new runner");

  // The rest of the table, one row each, on the facts alone.
  const runner = "eph-runner-0123456789abcdef";
  const continues = (more: object) => ({ offer: both, sealedToMachine: false, continues: { sessionId: "s", onComputer: false, restorable: false, ...more } });
  expect(placeFor(continues({ onComputer: true })).to === "computer", "a follow-up on the cloud computer's session goes to it");
  expect(JSON.stringify(placeFor(continues({ runnerNodeId: runner, restorable: true }))) === JSON.stringify({ to: "own-runner", nodeId: runner }), "a follow-up on a sleeping runner's session wakes that runner");
  expect(placeFor({ ...continues({}), offer: { computer: false, runners: true } }).to === "wait", "a follow-up nothing in the cloud can restore waits for the account's own machines");
  expect(placeFor({ offer: { computer: false, runners: false }, sealedToMachine: true }).to === "wait", "sealed work with no cloud computer waits too");
}

try {
  await main();
  await routing();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopTestServices(procs);
}
