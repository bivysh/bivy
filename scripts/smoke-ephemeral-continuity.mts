// SPDX-License-Identifier: AGPL-3.0-only
// Opt-in, billable integration probe. See docs/ephemeral-continuity-verification.md.
// Only a disposable account on an isolated LOCAL control plane is permitted.
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Ws from "ws";
import { createCredentialVault } from "../src/credentials/store.js";
import { seal } from "../src/e2e.js";
import { createLocalStore } from "../packages/core/src/local-store.js";
import { RelayTransport } from "../packages/core/src/transport-relay.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
if (process.env.BIVY_CONTINUITY !== "1") throw new Error("Set BIVY_CONTINUITY=1 to permit billable test machines");
const base = required("BIVY_CONTINUITY_CONTROL_PLANE_URL").replace(/\/$/, "");
const url = new URL(base);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("An isolated loopback control plane is required");
const publicUrl = required("BIVY_CONTINUITY_PUBLIC_URL").replace(/\/$/, "");
if (new URL(publicUrl).protocol !== "https:") throw new Error("Guest ingress must use HTTPS");
const providerId = required("BIVY_CONTINUITY_PROVIDER");
const modelId = required("BIVY_CONTINUITY_MODEL");
const runtimeId = required("BIVY_CONTINUITY_RUNTIME");
const imageCommit = required("BIVY_CONTINUITY_IMAGE_COMMIT");
if (!/^[0-9a-f]{40}$/.test(imageCommit)) throw new Error("An exact runner commit SHA is required");
const operator = required("MANAGED_PROVIDER_TOKEN_FLY");
const reportPath = process.env.BIVY_CONTINUITY_REPORT || "artifacts/ephemeral-continuity-live.json";
const credentialDir = process.env.BIVY_CONTINUITY_CREDENTIAL_DIR || path.join(os.homedir(), ".bivy", "credentials");
const credentialId = process.env.BIVY_CONTINUITY_CREDENTIAL || providerId;
class ProbeSocket extends Ws { constructor(address: string) { super(address, { handshakeTimeout: 15_000 }); } }

let accountToken = "", seedToken = "", phase = "account", status = "";
let transport: RelayTransport | undefined;
const events: any[] = [];
const secrets = [operator];
const safe = (value: unknown) => secrets.reduce((s, key) => key ? s.replaceAll(key, "[redacted]") : s, String(value || ""));
const report: any = {
  scope: "Isolated local authenticated control plane; real Fly, OAuth model, E2E relay, snapshot and rebuild. Not staging/production certification.",
  imageCommit, controlPlaneCommit: process.env.BIVY_CONTINUITY_CONTROL_PLANE_COMMIT || "unreported",
  runtimeId, providerId, modelId, apps: [], machines: [], passed: false,
  continuityFidelity: "portable conversation replay, not byte-identical native runtime state",
  credentialConstraints: "Access-only filtered grant; no refresh token copied or refreshed; no billing-account changes",
};
const requestId = "continuity-" + randomUUID();
const marker = "BIVY_CONTINUITY_" + randomUUID().replaceAll("-", "");
async function api(route: string, method = "GET", body?: unknown, token = accountToken): Promise<any> {
  const response = await fetch(base + route, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status}`);
  return response.json();
}
async function fly(route: string): Promise<Response> {
  return fetch("https://api.machines.dev/v1" + route, { headers: { authorization: "Bearer " + operator }, signal: AbortSignal.timeout(15_000) });
}
async function wait(check: () => any | Promise<any>, label: string, timeout = 150_000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out: " + label);
}
async function save(): Promise<void> {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}
function memory(): Storage {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); }, clear: () => data.clear(), key: (i) => [...data.keys()][i] ?? null, get length() { return data.size; } };
}
async function connect(machine: any, roomKey: string): Promise<void> {
  secrets.push(roomKey);
  transport?.close(); events.length = 0; status = "";
  const store = createLocalStore(memory(), memory());
  store.s = accountToken; store.cp = base; store.cur = machine.nodeId;
  store.relay = publicUrl.replace("https:", "wss:") + "/relay";
  store.addKey(machine.nodeId, roomKey);
  transport = new RelayTransport({ store, webSocketImpl: ProbeSocket as never, handlers: {
    onStatus: (value) => { status = value; }, onEvent: (event) => { events.push(event); },
    onError: (message) => { report.relayErrors = (report.relayErrors || 0) + 1; report.lastRelayError = safe(message); },
  } });
  await transport.connect();
  await wait(() => status === "online", "encrypted relay connection");
  let lastRequest = 0;
  await wait(async () => {
    if (Date.now() - lastRequest > 3000) { lastRequest = Date.now(); await transport!.send({ kind: "credentials.list" }); }
    return events.some((e) => e.type === "credentials.records" && e.records?.some((r: any) => r.provider === providerId));
  }, "filtered guest credential", 60_000);
  report.credentialDeliveryPhases = [...(report.credentialDeliveryPhases || []), phase];
}
async function event(check: (e: any) => boolean, label: string, from = 0): Promise<any> {
  return wait(() => {
    const rows = events.slice(from);
    if (rows.some((e) => e.type === "session.error" || e.type === "session.auth_required")) throw new Error("Agent failed during " + label);
    return rows.find(check);
  }, label);
}
async function history(sessionId: string): Promise<any> {
  const from = events.length;
  await transport!.send({ kind: "history", sessionId });
  return event((e) => e.type === "session.history" && e.sessionId === sessionId, "session history", from);
}
async function prompt(sessionId: string, text: string): Promise<any> {
  const from = events.length;
  await transport!.send({ kind: "prompt", sessionId, text, requestId: randomUUID() });
  const end = await event((e) => e.type === "session.event" && e.sessionId === sessionId && e.event?.type === "agent_end", "real model turn", from);
  if (end.event.error || end.event.aborted) throw new Error("Model turn did not complete");
  return history(sessionId);
}
try {
  // Read-only access to an explicitly selected existing credential. Never refresh.
  const credential = await createCredentialVault(credentialDir).readRecord(credentialId);
  if (credential?.source.kind !== "stored" || credential.source.cred.type !== "oauth" || credential.source.cred.expires < Date.now() + 900_000) throw new Error("A still-valid OAuth access credential is required (15+ minutes remaining)");
  if (credential.provider !== providerId) throw new Error("Credential provider does not match the requested provider");
  secrets.push(credential.source.cred.access);
  const grant = structuredClone(credential);
  grant.unattended = true;
  if (grant.source.kind !== "stored" || grant.source.cred.type !== "oauth") throw new Error("Unsupported credential");
  grant.source.cred.refresh = "";
  const account = await api("/auth/dev-login", "POST", { email: "continuity-" + randomUUID() + "@example.invalid" }, "");
  accountToken = account.token; secrets.push(accountToken); report.accountId = account.account.id;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const attemptId = "interactive-" + hash(JSON.stringify([report.accountId, requestId])).slice(0, 48);
  report.apps.push("bivy-" + hash(attemptId).slice(0, 32)); await save();
  const defaults = await api("/account/onboarding/managed-defaults", "POST");
  if (defaults.config.provider !== "fly" || !(defaults.config.ttlMinutes > 0 && defaults.config.ttlMinutes <= 5) || !defaults.config.teardownOnAgentFinish) throw new Error("Test defaults must be Fly, TTL <= 5 minutes, teardown-on-finish enabled");
  if (!defaults.config.image?.includes(imageCommit)) throw new Error("Configured image does not match the reported commit");
  const seed = await api("/nodes/enroll", "POST", { nodeId: "cert-seed-" + randomUUID(), name: "Temporary filtered grant" });
  seedToken = seed.enrollmentToken; secrets.push(seedToken);
  const key = randomBytes(32); secrets.push(key.toString("base64"));
  const ciphertext = seal(key, JSON.stringify({ v: 3, providers: {}, deletedAt: {}, localModels: {}, records: { [providerId + ":default"]: grant }, recordsDeletedAt: {} }));
  await api("/node/model-auth-hosted-vault", "PUT", { vaultKeyB64: key.toString("base64"), ciphertext, expectedGeneration: 0, revision: Date.now() }, seedToken);
  report.filteredGrantPublished = true;
  phase = "launch";
  const started = Date.now();
  const request = { requestId, runtimeId, configId: defaults.config.id };
  const first = await api("/account/managed-machines", "POST", request);
  report.providerAcceptedMs = Date.now() - started;
  report.nodeId = first.machine.nodeId; report.machines.push(first.machine.id); secrets.push(first.roomKey);
  const observed = await fly(`/apps/${report.apps[0]}/machines/${first.machine.id}`);
  if (!observed.ok) throw new Error("Operator credential cannot independently observe the test machine");
  report.providerInitiallyObserved = true;
  const replay = await api("/account/managed-machines", "POST", request);
  if (replay.machine.id !== first.machine.id || replay.roomKey !== first.roomKey) throw new Error("HTTP replay changed launch identity");
  report.httpReplayConfirmed = true; await save();
  phase = "attach"; await connect(first.machine, first.roomKey);
  report.encryptedAttachMs = Date.now() - started;
  await event((e) => e.type === "runtimes.list" && e.runtimes?.some((r: any) => r.id === runtimeId && r.available !== false), "requested runtime");
  await event((e) => e.type === "models.list" && e.models?.some((m: any) => m.provider === providerId && m.id === modelId), "requested model");
  const from = events.length;
  await transport!.send({ kind: "session.new", requestId: "cert-session", agent: runtimeId, model: { provider: providerId, id: modelId }, workspace: "/workspace", acknowledgeReducedProtections: true });
  const created = await event((e) => e.type === "session.history" && e.requestId === "cert-session", "session creation", from);
  const sessionId = created.sessionId; report.sessionId = sessionId;
  phase = "first-turn";
  const initial = await prompt(sessionId, `Remember this marker for later: ${marker}. Reply with exactly the marker, nothing else. Do not use tools.`);
  if (!JSON.stringify(initial.messages?.filter((m: any) => m.role === "assistant").at(-1)).includes(marker)) throw new Error("First model reply lacks the marker");
  report.firstModelReply = true;
  phase = "snapshot-and-teardown"; transport!.close();
  await wait(async () => { try { const snapshot = await api("/node/session-snapshot/" + sessionId, "GET", undefined, seedToken); return typeof snapshot.ciphertext === "string" && !snapshot.ciphertext.includes(marker); } catch { return false; } }, "encrypted snapshot");
  report.snapshotConfirmed = true;
  await wait(async () => !(await api("/account/hosted-machines")).some((m: any) => m.nodeId === first.machine.nodeId), "first teardown", 180_000);
  await wait(async () => (await fly(`/apps/${report.apps[0]}/machines/${first.machine.id}`)).status === 404, "provider-confirmed first machine absence");
  report.firstTeardownConfirmed = true;
  phase = "restore";
  const restored = await api("/account/managed-machines/restore", "POST", { configId: defaults.config.id, nodeId: first.machine.nodeId, sessionId, requestId: "restore-" + requestId });
  report.machines.push(restored.machine.id);
  if (restored.machine.id === first.machine.id || restored.machine.nodeId !== first.machine.nodeId || restored.roomKey !== first.roomKey) throw new Error("Rebuild did not preserve node/key identity on a new machine");
  await save(); await connect(restored.machine, restored.roomKey);
  await wait(async () => (await api("/account/hosted-machines")).find((m: any) => m.nodeId === first.machine.nodeId)?.milestones?.snapshotReadyAt, "restored runtime readiness");
  await transport!.send({ kind: "session.open", sessionId });
  const before = await history(sessionId);
  if (!JSON.stringify(before.messages).includes(marker)) throw new Error("Restored transcript lacks the marker");
  report.transcriptRestored = true;
  phase = "second-turn";
  const after = await prompt(sessionId, "What was the marker I asked you to remember? Reply exactly RESTORED:<marker>, replacing <marker> with the prior value. Do not use tools.");
  const assistants = after.messages.filter((m: any) => m.role === "assistant");
  if (assistants.length <= before.messages.filter((m: any) => m.role === "assistant").length || !JSON.stringify(assistants.at(-1)).includes("RESTORED:" + marker)) throw new Error("No new assistant reply recalled the prior context");
  report.secondModelReply = true;
} catch (error) {
  report.failedPhase = phase; report.error = safe(error instanceof Error ? error.message : error);
  report.nodeError = safe(events.find((e) => e.type === "session.error")?.error).slice(0, 1200);
  report.authError = safe(events.find((e) => e.type === "session.auth_required")?.reason).slice(0, 1200);
  report.eventTypes = [...new Set(events.map((e) => e.type))]; report.connectionStatus = status;
} finally {
  transport?.close();
  try {
    if (accountToken) {
      await api("/account/hosted-provisioning", "PUT", { enabled: false });
      for (const machine of await api("/account/hosted-machines")) await api("/account/hosted-machines/" + encodeURIComponent(machine.nodeId), "DELETE");
      await wait(async () => !(await api("/account/hosted-machines")).length, "final inventory cleanup", 90_000);
      report.inventoryCleared = true;
    }
  } catch (error) { report.inventoryCleared = false; report.cleanupError = safe(error instanceof Error ? error.message : error); }
  try {
    if (report.providerInitiallyObserved) {
      await wait(async () => (await fly("/apps/" + report.apps[0])).status === 404, "provider app absence", 90_000);
      report.providerAppAbsenceConfirmed = true;
    }
  } catch { report.providerAppAbsenceConfirmed = false; }
  report.passed = Boolean(report.secondModelReply && report.inventoryCleared && report.providerAppAbsenceConfirmed);
  if (!report.passed) process.exitCode = 1;
  await save(); console.log(JSON.stringify(report, null, 2));
}
