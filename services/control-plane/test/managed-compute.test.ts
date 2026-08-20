// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Managed compute lane: the same server-side provisioner as hosted BYO-cloud,
// launching with an OPERATOR-owned provider token resolved by the config's
// computeSource. Covers token-source resolution per compute source, the
// MANAGED_COMPUTE_ENABLED kill switch (gates NEW launches only — teardown and
// creation-retry-abandonment keep running), and that the operator token never
// leaks into stored records or the audit trail.
import assert from "node:assert/strict";
process.env.HOSTED_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
import { createPgMemStore } from "../src/pg-mem-store.js";
import { providerCredentialFingerprint, type EphemeralNodeConfig } from "../src/store.js";
import {
  planAutoProvision,
  hostedExecutionReadiness,
  provisionEphemeralForAccount,
  reconcileHostedMachines,
  reapSettledHostedMachine,
  type DestroyFn,
  type ObserveFn,
} from "../src/ephemeral-provisioner.js";
import { managedComputeEnabled, normalizeComputeSource, envOperatorTokenSource } from "../src/managed-compute.js";
import type { launchEphemeralMachine } from "@bivy/core";

const env = { cpBaseUrl: "https://cp", relayUrl: "wss://relay" };
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const OPERATOR_TOKEN = "operator-fly-token-do-not-leak";

const MANAGED_CONFIG: EphemeralNodeConfig = {
  id: "cfg-managed", name: "Managed runner", provider: "fly", region: "iad",
  ttlMinutes: 60, computeSource: "managed", createdAt: "", updatedAt: "",
};

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

async function makeStore() {
  const store = createPgMemStore();
  await store.init();
  return store;
}

/** Opted-in account routed at a managed config; NO user provider tokens. */
async function managedAccount() {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("managed@example.com");
  await store.setHostedProvisioning(account.id, { enabled: true });
  await store.setEphemeralConfigs(account.id, [MANAGED_CONFIG]);
  await store.setQueueRouting(account.id, { primary: { kind: "config", configId: MANAGED_CONFIG.id } });
  return { store, acctId: account.id };
}

// Injected launcher that behaves like the production one: emits a lifecycle
// event, registers the machine, and returns it — while capturing which
// provider credential the launch deps carry.
function fakeLauncher(seen: { token?: string }) {
  return (async (args, deps) => {
    seen.token = await deps.keys.getToken(args.provider);
    await args.onLifecycle?.({ attemptId: args.attemptId, phase: "requested", nodeId: "eph-managed-1" });
    const machine = {
      id: "fly-m1", provider: args.provider, nodeId: "eph-managed-1", attemptId: args.attemptId,
      createdAt: new Date().toISOString(), ttlMinutes: args.ttlMinutes ?? 60, status: "running",
      setupId: args.setupId, purpose: args.purpose,
    };
    await deps.machines.add(machine as never);
    return machine;
  }) as unknown as typeof launchEphemeralMachine;
}

await test("managedComputeEnabled: default OFF, only exact '1' enables", () => {
  assert.equal(managedComputeEnabled({} as never), false, "unset → off (default)");
  assert.equal(managedComputeEnabled({ MANAGED_COMPUTE_ENABLED: "1" } as never), true, "=1 → on");
  assert.equal(managedComputeEnabled({ MANAGED_COMPUTE_ENABLED: "0" } as never), false, "=0 → off");
  assert.equal(managedComputeEnabled({ MANAGED_COMPUTE_ENABLED: "true" } as never), false, "only exact '1' enables");
});

await test("normalizeComputeSource: absent/unknown → user (backward compatible)", () => {
  assert.equal(normalizeComputeSource(undefined), "user");
  assert.equal(normalizeComputeSource("managed"), "managed");
  assert.equal(normalizeComputeSource("MANAGED"), "user", "no case-folding surprises");
  assert.equal(normalizeComputeSource(42), "user");
});

await test("envOperatorTokenSource: MANAGED_PROVIDER_TOKEN_<PROVIDER> per provider", async () => {
  const source = envOperatorTokenSource({ MANAGED_PROVIDER_TOKEN_FLY: " fly-op ", MANAGED_PROVIDER_TOKEN_AWS: "" } as never);
  assert.equal(await source.getToken("fly"), "fly-op", "trimmed env token");
  assert.equal(await source.getToken("FLY"), "fly-op", "provider id is case-insensitive");
  assert.equal(await source.getToken("aws"), undefined, "empty env value → unconfigured");
  assert.equal(await source.getToken("hetzner"), undefined, "no env var → unconfigured");
  assert.equal(await source.getToken(""), undefined);
});

await test("computeSource survives the store round-trip; junk values are dropped", async () => {
  const store = await makeStore();
  const account = await store.findOrCreateAccount("roundtrip@example.com");
  await store.setEphemeralConfigs(account.id, [
    MANAGED_CONFIG,
    { ...MANAGED_CONFIG, id: "cfg-user", computeSource: undefined },
    { ...MANAGED_CONFIG, id: "cfg-junk", computeSource: "operator" as never },
  ]);
  const configs = await store.getEphemeralConfigs(account.id);
  assert.equal(configs.find((c) => c.id === "cfg-managed")?.computeSource, "managed");
  assert.equal(configs.find((c) => c.id === "cfg-user")?.computeSource, undefined);
  assert.equal(configs.find((c) => c.id === "cfg-junk")?.computeSource, undefined, "unknown value normalizes to the user lane");
});

const PREV = {
  MANAGED_COMPUTE_ENABLED: process.env.MANAGED_COMPUTE_ENABLED,
  MANAGED_PROVIDER_TOKEN_FLY: process.env.MANAGED_PROVIDER_TOKEN_FLY,
  EPHEMERAL_MACHINES_ENABLED: process.env.EPHEMERAL_MACHINES_ENABLED,
};
try {
  delete process.env.EPHEMERAL_MACHINES_ENABLED;

  await test("kill switch off: a ready managed account must not plan a launch", async () => {
    delete process.env.MANAGED_COMPUTE_ENABLED;
    process.env.MANAGED_PROVIDER_TOKEN_FLY = OPERATOR_TOKEN;
    const { store, acctId } = await managedAccount();
    const plan = await planAutoProvision(store, acctId);
    assert.equal(plan.willProvision, false);
    assert.match(plan.reason, /MANAGED_COMPUTE_ENABLED/, "reason names the switch");
    const readiness = await hostedExecutionReadiness(store, acctId);
    assert.equal(readiness.ready, false);
    assert.match(readiness.reason, /MANAGED_COMPUTE_ENABLED/);
  });

  await test("switch on but no operator token: refused with a lane-specific reason", async () => {
    process.env.MANAGED_COMPUTE_ENABLED = "1";
    delete process.env.MANAGED_PROVIDER_TOKEN_FLY;
    const { store, acctId } = await managedAccount();
    const plan = await planAutoProvision(store, acctId);
    assert.equal(plan.willProvision, false);
    assert.match(plan.reason, /no operator token for provider fly/);
  });

  await test("switch on + operator token: managed account plans a launch with zero user credentials", async () => {
    process.env.MANAGED_COMPUTE_ENABLED = "1";
    process.env.MANAGED_PROVIDER_TOKEN_FLY = OPERATOR_TOKEN;
    const { store, acctId } = await managedAccount();
    assert.deepEqual(await planAutoProvision(store, acctId), { willProvision: true, targetConfigId: MANAGED_CONFIG.id, reason: "ready to provision" });
    assert.deepEqual(await hostedExecutionReadiness(store, acctId), { ready: true, reason: "hosted ephemeral execution is ready", configId: MANAGED_CONFIG.id });
  });

  await test("user-lane configs ignore the managed switch and still require the user's validated token", async () => {
    delete process.env.MANAGED_COMPUTE_ENABLED;
    process.env.MANAGED_PROVIDER_TOKEN_FLY = OPERATOR_TOKEN; // present but must not be used for the user lane
    const store = await makeStore();
    const account = await store.findOrCreateAccount("user-lane@example.com");
    await store.setHostedProvisioning(account.id, { enabled: true });
    await store.setEphemeralConfigs(account.id, [{ ...MANAGED_CONFIG, id: "cfg-user", computeSource: undefined }]);
    await store.setQueueRouting(account.id, { primary: { kind: "config", configId: "cfg-user" } });
    const plan = await planAutoProvision(store, account.id);
    assert.equal(plan.willProvision, false, "an operator token never substitutes for the user's own credential");
    assert.match(plan.reason, /no hosted token for provider fly/);
    await store.setHostedProvisioning(account.id, { enabled: true, providerTokens: { fly: "user-fly-token" }, validatedProviders: { fly: providerCredentialFingerprint("user-fly-token") } });
    assert.equal((await planAutoProvision(store, account.id)).willProvision, true, "user lane works with the managed switch off");
  });

  await test("managed launch uses the operator token and records the same attempt/audit trail", async () => {
    process.env.MANAGED_COMPUTE_ENABLED = "1";
    process.env.MANAGED_PROVIDER_TOKEN_FLY = OPERATOR_TOKEN;
    const { store, acctId } = await managedAccount();
    const seen: { token?: string } = {};
    const machine = await provisionEphemeralForAccount(store, acctId, MANAGED_CONFIG, env, fakeLauncher(seen));
    assert.equal(seen.token, OPERATOR_TOKEN, "the launch deps carry the operator credential");
    assert.equal(machine.nodeId, "eph-managed-1");
    const attempt = await store.getHostedMachineAttempt(acctId, String(machine.attemptId));
    assert.equal(attempt?.state, "tracked");
    assert.equal(attempt?.desired.computeSource, "managed", "compute source rides on the durable attempt row");
    const actions = (await store.listHostedAudit(acctId, 20)).map((e) => e.action);
    assert.ok(actions.includes("provision_attempt") && actions.includes("provision_launched"), "same audit events as a hosted launch");
  });

  await test("the operator token never appears in stored records, audit, or API-shaped views", async () => {
    process.env.MANAGED_COMPUTE_ENABLED = "1";
    process.env.MANAGED_PROVIDER_TOKEN_FLY = OPERATOR_TOKEN;
    const { store, acctId } = await managedAccount();
    await provisionEphemeralForAccount(store, acctId, MANAGED_CONFIG, env, fakeLauncher({}));
    const persisted = JSON.stringify({
      machines: await store.getHostedMachines(acctId),
      attempts: await store.listHostedMachineAttempts(acctId, true),
      audit: await store.listHostedAudit(acctId, 100),
      configs: await store.getEphemeralConfigs(acctId),
      hosted: await store.getHostedProvisioning(acctId),
    });
    assert.ok(!persisted.includes(OPERATOR_TOKEN), "no plaintext operator token in any persisted/serializable record");
  });

  await test("kill switch off: TTL teardown of a managed machine still runs, with the operator token", async () => {
    delete process.env.MANAGED_COMPUTE_ENABLED; // launches gated OFF
    process.env.MANAGED_PROVIDER_TOKEN_FLY = OPERATOR_TOKEN; // cleanup credential stays available
    const { store, acctId } = await managedAccount();
    const machine = { id: "fly-old", provider: "fly", nodeId: "eph-old", attemptId: "att-old", setupId: MANAGED_CONFIG.id, createdAt: iso(200 * 60_000), ttlMinutes: 60, status: "running" };
    await store.setHostedMachines(acctId, [machine]);
    await store.putHostedMachineAttempt({
      accountId: acctId, attemptId: "att-old", provider: "fly", nodeId: "eph-old",
      state: "tracked", desired: { computeSource: "managed", setupId: MANAGED_CONFIG.id }, machine, retryCount: 0,
      createdAt: machine.createdAt, updatedAt: machine.createdAt,
    });
    let destroyToken: string | undefined;
    let destroyed = false;
    const destroy: DestroyFn = async (m, deps) => { destroyed = true; destroyToken = await deps.keys.getToken(m.provider); };
    const observe: ObserveFn = async () => (destroyed ? "gone" : "running");
    const reaped = await reconcileHostedMachines(store, acctId, Date.now(), env, destroy, observe);
    assert.equal(reaped, 1, "cleanup runs while the launch switch is off");
    assert.equal(destroyToken, OPERATOR_TOKEN, "teardown resolved the managed lane's credential");
    assert.deepEqual(await store.getHostedMachines(acctId), []);
  });

  await test("kill switch off: a managed creation retry is held, not run and not abandoned", async () => {
    delete process.env.MANAGED_COMPUTE_ENABLED;
    process.env.MANAGED_PROVIDER_TOKEN_FLY = OPERATOR_TOKEN;
    const { store, acctId } = await managedAccount();
    await store.putHostedMachineAttempt({
      accountId: acctId, attemptId: "att-retry", provider: "fly", nodeId: "eph-retry",
      state: "failed", desired: { computeSource: "managed", setupId: MANAGED_CONFIG.id }, retryCount: 1,
      createdAt: iso(2 * 60 * 60_000), updatedAt: iso(2 * 60 * 60_000),
    });
    await reconcileHostedMachines(store, acctId, Date.now(), env, async () => {}, async () => "running");
    const attempt = await store.getHostedMachineAttempt(acctId, "att-retry");
    assert.equal(attempt?.state, "failed", "no retry launched while the switch is off");
    assert.equal(attempt?.retryCount, 1, "retry budget untouched — it resumes when the switch returns");
  });

  await test("settled-reap of a managed machine resolves the operator token", async () => {
    delete process.env.MANAGED_COMPUTE_ENABLED;
    process.env.MANAGED_PROVIDER_TOKEN_FLY = OPERATOR_TOKEN;
    const { store, acctId } = await managedAccount();
    const machine = { id: "fly-settled", provider: "fly", nodeId: "eph-settled", attemptId: "att-settled", setupId: MANAGED_CONFIG.id, createdAt: iso(5 * 60_000), ttlMinutes: 60, status: "running" };
    await store.setHostedMachines(acctId, [machine]);
    await store.putHostedMachineAttempt({
      accountId: acctId, attemptId: "att-settled", provider: "fly", nodeId: "eph-settled",
      state: "working", desired: { computeSource: "managed" }, machine, retryCount: 0,
      createdAt: machine.createdAt, updatedAt: machine.createdAt,
    });
    let destroyToken: string | undefined;
    const destroy: DestroyFn = async (m, deps) => { destroyToken = await deps.keys.getToken(m.provider); };
    const handled = await reapSettledHostedMachine(store, acctId, "eph-settled", env, Date.now(), destroy, async () => "gone");
    assert.equal(handled, true);
    assert.equal(destroyToken, OPERATOR_TOKEN);
    const attempt = await store.getHostedMachineAttempt(acctId, "att-settled");
    assert.equal(attempt?.state, "deleted", "same confirmed-deletion finalizer as the hosted lane");
  });
} finally {
  for (const [key, value] of Object.entries(PREV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

console.log(`managed-compute: ${passed} test(s) passed`);
