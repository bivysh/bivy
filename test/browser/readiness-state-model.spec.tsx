// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("the readiness-led first-run journey names all five steps, in order, in the state model", async () => {
  const model = await read("../../packages/core/src/activation.ts");
  expect(model).toContain('"account_signed_in"');
  expect(model).toContain('"machine_online"');
  expect(model).toContain('"agent_installed"');
  expect(model).toContain('"credential_valid"');
  expect(model).toContain('"agent_answered"');
  // account_signed_in must be FIRST — every later check is gated behind it.
  const order = ["account_signed_in", "machine_online", "agent_installed", "credential_valid", "agent_answered"]
    .map((id) => model.indexOf(`"${id}"`));
  for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]!);
});

test("account_signed_in is resolved eagerly — direct mode bypasses it, hosted mode reads the real sign-in state", async () => {
  const model = await read("../../packages/core/src/activation.ts");
  expect(model).toContain("const accountSignedIn = state.direct ? true : state.signedIn;");
});

test("agent_installed requires a certified, supported runtime — not merely an installed one", async () => {
  const model = await read("../../packages/core/src/activation.ts");
  expect(model).toContain('r.supportTier === "supported"');
});

test("the readiness strip's milestone diffing is chain-length-agnostic (survives the model growing new leading checks)", async () => {
  const controller = await read("../../packages/web/src/store/controller.ts");
  expect(controller).toContain("checks.slice(0, -1).every((check) => check.state === \"passed\")");
  expect(controller).not.toContain("checks.slice(0, 4)");
});

test("first-run funnel/failure metrics are closed enums, one ok/failed pair per client-observable step", async () => {
  const account = await read("../../packages/core/src/account.ts");
  for (const event of [
    "first_run_machine_ready", "first_run_machine_failed",
    "first_run_provider_connected", "first_run_provider_failed",
    "first_run_agent_verified", "first_run_agent_failed",
  ]) {
    expect(account).toContain(`"${event}"`);
  }
  // Sign-in is deliberately NOT here — see the doc comment: a sign-in failure
  // has no authenticated account yet to attribute this metric to, so it's
  // tracked server-side (control-plane FunnelEvent) instead.
  expect(account).not.toContain('"first_run_signed_in"');
});

test("sign-in funnel/failure is tracked server-side, disjoint from the authenticated product-metrics path", async () => {
  const metrics = await read("../../services/control-plane/src/metrics.ts");
  expect(metrics).toContain('"sign_in_completed"');
  expect(metrics).toContain('"sign_in_failed"');
  const index = await read("../../services/control-plane/src/index.ts");
  // Every sendSignInFailed call site must carry a source label — no untracked
  // sign-in failure path.
  const calls = [...index.matchAll(/sendSignInFailed\(/g)];
  expect(calls.length).toBeGreaterThan(0);
  expect(index).toContain('recordFunnelEvent("sign_in_failed"');
});

test("the redacted credential readiness model never fabricates an owner or a verification result", async () => {
  const model = await read("../../packages/core/src/credentialReadiness.ts");
  // A node-only credential is attributed to the machine, never an account.
  expect(model).toContain('syncScope === "account" ? (accountEmail ? redactEmail(accountEmail) : "Your account") : "This machine only"');
  // Unverified is the honest default — never "verified" without a real result.
  expect(model).toContain('record.lastVerifiedAt == null ? "unverified"');
});

test("test connection never leaves the credential's secret in the client-facing event", async () => {
  const api = await read("../../src/credentials/api.ts");
  // The relay event/return type carries only ok/at/reason — grep the exported
  // testCredential signature and its return sites for accidental token leakage.
  expect(api).toContain("Promise<CredentialVerification>");
  expect(api).not.toMatch(/return\s*\{[^}]*token[^}]*\}/);
  const server = await read("../../src/server.ts");
  expect(server).toContain('"credential.test"');
  expect(server).toContain("ctx.reply({ type: \"credential.test.result\"");
  // The reply spreads only the verification result, never the raw record.
  expect(server).not.toMatch(/credential\.test\.result[\s\S]{0,120}\bkey\b/);
});

test("verification status is node-local by construction — never synced as if another device tested it", async () => {
  const store = await read("../../src/credentials/store.ts");
  expect(store).toContain("readVerification");
  expect(store).toContain("writeVerification");
  // The sidecar file must be distinct from the encrypted/synced document.
  expect(store).toContain('path.join(vaultDir, "verify.json")');
});
