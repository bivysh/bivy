// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// End-to-end coverage for the shared-evaluator wiring: the
// POST /account/automations/simulate endpoint (the control-plane half of the
// PWA Test event workflow — see docs/automation-evaluator.md) and the
// save-time preflight gate on POST/PUT /account/automations.
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
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
}
async function main() {
  const port = await freePort();
  const proc = spawnTestService(cpDir, { PORT: String(port), RELAY_SECRET: "simulate-test" });
  procs.push(proc);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/healthz`)).ok) { ready = true; break; }
    } catch {}
    await delay(100);
  }
  if (!ready) throw new Error("Control plane did not start");

  const login = await json(port, "POST", "/auth/dev-login", { email: "simulate@example.com" });
  const token = login.body.token;

  // --- Save gate: autonomous + danger-full-access is blocked without an
  //     explicit acknowledgement, on both create and update. ---
  const unsafeCreate = await json(port, "POST", "/account/automations", {
    name: "Unsafe", trigger: "manual", templateCiphertext: "bivy-room-v1:node-x:opaque",
    approvalMode: "autonomous", sandbox: "danger-full-access",
  }, token);
  expect(unsafeCreate.status === 400 && Array.isArray(unsafeCreate.body.preflight), "autonomous + danger-full-access is blocked at create without acknowledgement");

  const ackedCreate = await json(port, "POST", "/account/automations", {
    name: "Acked", trigger: "manual", templateCiphertext: "bivy-room-v1:node-x:opaque",
    approvalMode: "autonomous", sandbox: "danger-full-access", allowDangerous: true,
  }, token);
  expect(ackedCreate.status === 201, "the same combo saves once allowDangerous acknowledges it");

  const safeCreate = await json(port, "POST", "/account/automations", {
    name: "Safe", trigger: "manual", templateCiphertext: "bivy-room-v1:node-x:opaque",
    approvalMode: "risky", sandbox: "workspace-write",
  }, token);
  expect(safeCreate.status === 201, "a safe combo is unaffected by the new gate");

  const unsafeUpdate = await json(port, "PUT", `/account/automations/${safeCreate.body.id}`, {
    approvalMode: "autonomous", sandbox: "danger-full-access",
  }, token);
  expect(unsafeUpdate.status === 400, "tightening an existing automation to the unsafe combo is blocked at update too");

  const ackedUpdate = await json(port, "PUT", `/account/automations/${safeCreate.body.id}`, {
    approvalMode: "autonomous", sandbox: "danger-full-access", allowDangerous: true,
  }, token);
  expect(ackedUpdate.status === 200 && ackedUpdate.body.allowDangerous === true, "the acknowledgement persists and unblocks update");

  // --- Simulate: first-match explanation, overlap warning, and preflight for
  //     a brand-new (never-saved) draft. ---
  const catchAll = await json(port, "POST", "/account/automations", {
    name: "Catch all issues", trigger: "github", repo: "acme/api",
    templateCiphertext: "bivy-room-v1:node-x:opaque", on: [{ event: "issues" }],
  }, token);
  expect(catchAll.status === 201, "seed automation for overlap/match fixtures saves");

  const noInstructions = await json(port, "POST", "/account/automations/simulate", {
    draft: { trigger: "github", repo: "acme/api", on: [{ event: "issues" }] },
  }, token);
  expect(noInstructions.status === 200 && noInstructions.body.gate.blocked === true, "a draft with no instructions yet blocks save (encrypted_key_ownership)");

  const draftSim = await json(port, "POST", "/account/automations/simulate", {
    draft: {
      trigger: "github", repo: "acme/api",
      templateCiphertext: "bivy-room-v1:node-x:opaque",
      on: [{ event: "issues", actions: ["labeled"] }],
    },
    event: { kind: "github", repo: "acme/api", event: "issues", action: "labeled", labels: ["bivy"] },
  }, token);
  expect(draftSim.status === 200, "simulate accepts a brand-new draft that was never saved");
  expect(draftSim.body.matchedId === catchAll.body.id, "the earlier catch-all automation wins first-match over the draft");
  expect(draftSim.body.overlaps.some((o: any) => o.kind === "shadowed" && o.beforeId === catchAll.body.id), "simulate reports that the draft is shadowed by the earlier catch-all");
  expect(Array.isArray(draftSim.body.preflight) && draftSim.body.preflight.length === 6, "simulate returns the full six-check preflight checklist");
  expect(draftSim.body.gate.blocked === false, "a plain github draft does not block save");

  const badDraftSim = await json(port, "POST", "/account/automations/simulate", { draft: { repo: "acme/api" } }, token);
  expect(badDraftSim.status === 400, "simulate rejects a draft with no trigger");

  const noSubject = await json(port, "POST", "/account/automations/simulate", { event: { kind: "github", event: "issues" } }, token);
  expect(noSubject.status === 400, "simulate requires either automationId or draft");

  const missingAutomation = await json(port, "POST", "/account/automations/simulate", { automationId: "not-real" }, token);
  expect(missingAutomation.status === 404, "simulate 404s on an unknown automationId");

  // --- Simulate previewing an unsaved edit to an existing automation. ---
  const editPreview = await json(port, "POST", "/account/automations/simulate", {
    automationId: catchAll.body.id,
    draft: { approvalMode: "autonomous", sandbox: "danger-full-access" },
  }, token);
  expect(editPreview.status === 200 && editPreview.body.gate.blocked === true, "simulate previews an unsaved edit's gate without persisting it");
  const stillSafe = await json(port, "GET", "/account/automations", undefined, token);
  expect(stillSafe.body.find((d: any) => d.id === catchAll.body.id)?.sandbox !== "danger-full-access", "previewing a draft edit via simulate never mutates the stored automation");

  // --- Concurrency: many simultaneous simulate calls for distinct drafts
  //     against the same account never cross-contaminate each other's result
  //     (the endpoint does no shared mutable-state bookkeeping per request). ---
  // The event's label ("concurrency-N") never matches catch-all's implicit
  // default "bivy" label filter, so each request's OWN draft must be the
  // match — a shared-mutable-state bug (e.g. a captured loop variable) would
  // instead collapse every response onto the same draft or onto catch-all.
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, (_, i) => json(port, "POST", "/account/automations/simulate", {
      draft: { trigger: "github", repo: "acme/api", on: [{ event: "issues", labels: [`concurrency-${i}`] }] },
      event: { kind: "github", repo: "acme/api", event: "issues", labels: [`concurrency-${i}`] },
    }, token)),
  );
  expect(concurrent.every((r) => r.status === 200), "every concurrent simulate call succeeds");
  expect(concurrent.every((r) => r.body.matchedId !== catchAll.body.id), "no concurrent draft falls through to catch-all (each carries a distinct, non-bivy label)");
  expect(new Set(concurrent.map((r) => r.body.matchedId)).size === concurrent.length, "each concurrent request matches its own draft, not another request's");

  console.log("\nAll automation simulate/preflight checks passed.");
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopTestServices(procs);
}
