// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Boots the fleet: read the configuration, open the store, build the provider
// adapter, and run the reconcile loop beside the HTTP surface.
import { createApp } from "./app.js";
import { CloudComputers, type RunLedger } from "./computers.js";
import { httpCoreClient } from "./core.js";
import { LocalAdmission } from "./limits.js";
import { composeAdmission, HttpAdmission, type Admission } from "./policy.js";
import { machineProvider } from "./provider.js";
import { Runners } from "./runners.js";
import { FleetConfig } from "./settings.js";
import { MemoryFleetStore, PostgresFleetStore, type FleetStore } from "./store.js";

const config = new FleetConfig();
const token = config.coreToken();
const coreUrl = config.coreUrl();
if (!token || !coreUrl) {
  // Without these the fleet cannot be asked anything, nor ask Core for a boot
  // payload. Refuse to start rather than look healthy and launch nothing.
  console.error(`The fleet cannot start:\n- ${config.problems.join("\n- ")}`);
  process.exit(1);
}

const databaseUrl = config.databaseUrl();
const store: FleetStore = databaseUrl ? new PostgresFleetStore(databaseUrl) : new MemoryFleetStore();
if (!databaseUrl) console.warn("No DATABASE_URL: the fleet keeps its records in memory and forgets its machines on restart.");
await store.init();

const policy = config.policy();
const local = new LocalAdmission(store, config.limits());
const admission: Admission = policy ? composeAdmission(local, new HttpAdmission(policy.url, policy.token)) : local;
if (policy) console.log(`Policy service configured at ${policy.url}; its answers apply on top of this fleet's own caps.`);

const core = httpCoreClient(coreUrl, token);
const runs: RunLedger = {
  async settle(accountId, runId, at, machineSeconds) {
    await store.settle(accountId, runId, at, machineSeconds);
    await admission.runSettled?.(accountId, runId, at, machineSeconds)
      .catch((error) => console.warn("[fleet] run not reported to the policy service:", error instanceof Error ? error.message : error));
  },
  fail: (accountId, runId, at) => store.fail(accountId, runId, at),
};

let computers: CloudComputers | undefined;
let runners: Runners | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

if (config.offered) {
  const settings = config.computeSettings();
  const provider = machineProvider(config.provider(), config.providerToken()!, { ...(config.providerOrg() ? { org: config.providerOrg() } : {}) });
  computers = new CloudComputers({
    store, provider, core, settings, admission, runs,
    warnIdle: async (accountId, deleteAt) => void await core.notice(accountId, "computer", deleteAt),
  });
  if (config.runners) {
    runners = new Runners({
      store, provider, core, settings: config.runnerSettings(), admission, runs,
      sizeFor: (accountId) => computers!.sizeFor(accountId),
      warnSleeping: async (accountId, deleteAt) => void await core.notice(accountId, "runner", deleteAt),
    });
  }
  const reconcile = async () => {
    const machines = await computers!.reconcile();
    for (const app of machines.stopped) console.warn(`[fleet] CPU guard stopped ${app}: CPUs pinned for ${settings.cpuGuardMinutes} min`);
    for (const app of machines.outOfAllowance) console.log(`[fleet] stopped ${app}: the account's machine time is used up`);
    for (const app of machines.retired) console.log(`[fleet] deleted ${app}: allowance used up with none to come`);
    for (const app of machines.swept) console.warn(`[fleet] deleted orphaned app ${app}`);
    if (machines.deleted || machines.failed || machines.warned) {
      console.log(`[fleet] checked=${machines.checked} warned=${machines.warned} deleted=${machines.deleted} failed=${machines.failed}`);
    }
    if (!runners) return;
    const workers = await runners.reconcile();
    for (const machine of workers.stopped) console.warn(`[runners] stopped ${machine}: CPU guard, awake cap or allowance`);
    if (workers.disposed || workers.failed || workers.warned || workers.deleted) {
      console.log(`[runners] checked=${workers.checked} disposed=${workers.disposed} warned=${workers.warned} deleted=${workers.deleted} failed=${workers.failed}`);
    }
  };
  const sweep = () => void reconcile().catch((error) => console.warn("[fleet] reconcile failed:", error instanceof Error ? error.message : error));
  timer = setInterval(sweep, config.reconcileMs());
  timer.unref();
  sweep();
} else {
  // Reachable but launching nothing: Core sees no profile and keeps every
  // session on the machines people own.
  console.warn(`The fleet is withholding launches:\n- ${config.problems.join("\n- ")}`);
}

const app = createApp({ config, store, admission, computers, runners, token });
const port = config.port();
const server = app.listen(port, () => console.log(`Bivy fleet listening on :${port}`));

let stopping = false;
function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  console.log(`Received ${signal}; stopping the fleet`);
  server.close(() => {
    void (store instanceof PostgresFleetStore ? store.close() : Promise.resolve()).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 15_000).unref();
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
