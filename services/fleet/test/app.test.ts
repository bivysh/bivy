// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The fleet's HTTP surface: nothing answers without the shared token, a
// refusal reaches Core as a decision, and the configuration decides whether
// Core is offered a launch profile at all.
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { CloudComputers, type RunLedger } from "../src/computers.js";
import type { Admission } from "../src/policy.js";
import { FleetConfig } from "../src/settings.js";
import { MemoryFleetStore } from "../src/store.js";
import { computeSettings, expect, FakeCore, FakeProvider, run } from "./harness.js";

const TOKEN = "test-compute-token";
const ACCOUNT = "acc-1";

const WORKING_ENV = {
  FLEET_PROVIDER_TOKEN_FLY: "fly-token",
  FLEET_IMAGE: "registry/bivy-runner:1",
  FLEET_CORE_URL: "http://control-plane:4400",
  DEPLOYMENT_COMPUTE_TOKEN: TOKEN,
} as NodeJS.ProcessEnv;

async function serve(options: { admit?: Admission["admit"]; env?: NodeJS.ProcessEnv; earlyStarts?: boolean } = {}) {
  const store = new MemoryFleetStore();
  const provider = new FakeProvider();
  const core = new FakeCore();
  const runs: RunLedger = { settle: store.settle.bind(store), fail: store.fail.bind(store) };
  const admission: Admission = { admit: options.admit ?? (async () => ({ allowed: true })) };
  const config = new FleetConfig(options.env ?? WORKING_ENV);
  const computers = new CloudComputers({ store, provider, core, runs, admission, settings: computeSettings({ earlyStarts: options.earlyStarts }) });
  const app = createApp({ config, store, admission, computers, token: TOKEN });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const port = (server.address() as { port: number }).port;
  // `null` sends no header at all; an undefined argument would just take the default.
  const call = async (path: string, body: unknown, token: string | null = TOKEN) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
  };
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { call, get, store, provider, core, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function tokenGate() {
  const { call, get, close } = await serve();
  try {
    expect((await call("/v1/compute/machines", { subject: { accountId: ACCOUNT } }, null)).status === 401, "no token, no answer");
    expect((await call("/v1/compute/machines", { subject: { accountId: ACCOUNT } }, "wrong")).status === 401, "a wrong token is refused");
    expect((await get("/healthz")).status === 200, "the health check needs no token, so a proxy can use it");
  } finally {
    await close();
  }
}

async function acquireAndRefusal() {
  const open = await serve();
  try {
    const result = await open.call("/v1/compute/acquire", { subject: { accountId: ACCOUNT }, purpose: "interactive", requestId: "r1" });
    expect(result.status === 200 && result.body.state === "launching" && typeof result.body.nodeId === "string", "Core gets the node id of the machine being launched");
    const machines = await open.call("/v1/compute/machines", { subject: { accountId: ACCOUNT } });
    expect(Array.isArray(machines.body.machines) && (machines.body.machines as unknown[]).length === 1, "and sees it in the account's machines");
    const missing = await open.call("/v1/compute/acquire", { subject: {}, purpose: "interactive", requestId: "r1" });
    expect(missing.status === 400, "a request without an account is a bad request, not a crash");
  } finally {
    await open.close();
  }

  const closed = await serve({ admit: async () => ({ allowed: false, code: "machine_time", reason: "no hours left" }) });
  try {
    const refused = await closed.call("/v1/compute/acquire", { subject: { accountId: ACCOUNT }, purpose: "interactive", requestId: "r1" });
    expect(refused.status === 200 && refused.body.allowed === false && refused.body.reason === "no hours left", "a refusal reaches Core as the decision, for it to show");
  } finally {
    await closed.close();
  }
}

async function usageIsReported() {
  const { call, store, close } = await serve();
  try {
    await store.settle(ACCOUNT, "run-1", new Date().toISOString(), 1800);
    const usage = await call("/v1/compute/usage", { subject: { accountId: ACCOUNT } });
    expect(usage.body.seconds === 1800, "metered machine time is reported, which is what an invoice is built from");
    expect(usage.body.secondsLeft === undefined, "an unmetered fleet reports no allowance");
    const bad = await call("/v1/compute/usage", { subject: { accountId: ACCOUNT }, since: "last tuesday" });
    expect(bad.status === 400, "an unparseable window is rejected");
  } finally {
    await close();
  }
}

async function profileFollowsConfiguration() {
  const working = await serve();
  try {
    const profile = (await working.call("/v1/compute/profile", { purpose: "interactive" })).body.profile as Record<string, unknown>;
    expect(profile?.accountMachine === true && profile.image === "registry/bivy-runner:1", "a working fleet offers Core a launch profile");
    expect(profile.runners === undefined, "runners are offered only where they are turned on");
    expect((await working.call("/v1/compute/profile", { purpose: "nonsense" })).status === 400, "an unknown purpose is rejected");
  } finally {
    await working.close();
  }

  const broken = await serve({ env: { ...WORKING_ENV, FLEET_IMAGE: "" } });
  try {
    const profile = (await broken.call("/v1/compute/profile", { purpose: "interactive" })).body.profile;
    expect(profile === null, "a fleet with no image offers nothing, so sessions stay on machines people own");
    const ready = await broken.get("/readyz");
    expect(ready.status === 200 && ready.body.offered === false, "and says why, rather than looking like an outage");
  } finally {
    await broken.close();
  }
}

async function signUpStartsAComputer() {
  const { call, store, close } = await serve({ earlyStarts: true });
  try {
    const at = new Date().toISOString();
    await call("/v1/events", { subject: { accountId: ACCOUNT }, event: { type: "account.signed-in", at, accountCreatedAt: at } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(Boolean(await store.get(ACCOUNT)), "a brand-new account's computer starts at sign-up, so it is up when wanted");

    const older = new Date(Date.now() - 3_600_000).toISOString();
    await call("/v1/events", { subject: { accountId: "acc-2" }, event: { type: "account.signed-in", at: new Date().toISOString(), accountCreatedAt: older } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(!(await store.get("acc-2")), "a later sign-in does not restart a computer its owner may have released");
  } finally {
    await close();
  }
}

await run(tokenGate, acquireAndRefusal, usageIsReported, profileFollowsConfiguration, signUpStartsAComputer);
