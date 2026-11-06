// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The `command` provider (DISPATCH.md): a cloud computer's whole lifecycle
// runs through a dispatcher program, here a small script keeping its machines
// in a file, on a platform whose machines keep running after the node exits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudComputers, type RunLedger } from "../src/computers.js";
import { CommandProvider } from "../src/dispatch.js";
import { MemoryFleetStore } from "../src/store.js";
import { computeSettings, expect, FakeCore, run } from "./harness.js";

const ACCOUNT = "acc-1";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-dispatch-"));
const stateFile = path.join(dir, "state.json");
const script = path.join(dir, "dispatch.mjs");
fs.writeFileSync(script, `
import fs from "node:fs";
const op = process.env.BIVY_DISPATCH_OP;
const req = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const file = ${JSON.stringify(stateFile)};
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { machines: {}, ops: [] };
state.ops.push(op);
let out = {};
const m = (id) => state.machines[id];
switch (op) {
  case "describe": out = { capabilities: { stopsOnExit: false, keepsMemory: true, cpuReading: false } }; break;
  case "ensureVolume": case "createVolume": out = { volumeId: "" }; break;
  case "createMachine": { const id = "sbx-" + Object.keys(state.machines).length; state.machines[id] = { id, state: "started", region: req.spec.region, env: req.spec.init.exec.join(" ") }; out = { machine: state.machines[id] }; break; }
  case "getMachine": out = { machine: m(req.machineId) ?? null }; break;
  case "stopMachine": m(req.machineId).state = "stopped"; break;
  case "startMachine": m(req.machineId).state = "started"; break;
  case "updateMachine": out = { machine: m(req.machineId) }; break;
  case "fail": process.stderr.write("platform said no"); process.exit(3);
  default: break;
}
fs.writeFileSync(file, JSON.stringify(state));
process.stdout.write(JSON.stringify(out));
`);
const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8")) as { machines: Record<string, { state: string }>; ops: string[] };

async function lifecycleThroughADispatcher() {
  const provider = new CommandProvider(command);
  expect(!provider.capabilities.stopsOnExit && provider.capabilities.keepsMemory && !provider.capabilities.cpuReading, "the dispatcher describes what its platform's machines do");
  const store = new MemoryFleetStore();
  const runs: RunLedger = { settle: store.settle.bind(store), fail: store.fail.bind(store) };
  const computers = new CloudComputers({ store, provider, core: new FakeCore(), runs, admission: { admit: async () => ({ allowed: true }) }, settings: computeSettings() });

  const acquired = await computers.acquire({ accountId: ACCOUNT, purpose: "interactive", requestId: "r1" });
  expect(acquired.allowed && acquired.state === "launching", "a computer launches through the dispatcher");
  const [machine] = Object.values(state().machines);
  expect(machine?.state === "started" && (machine as unknown as { env: string }).env === "/bin/true", "the dispatcher got the boot command to run");

  const nodeId = (await store.get(ACCOUNT))!.nodeId;
  expect(await computers.asleep(ACCOUNT, nodeId), "when the node says it's going to sleep, the fleet stops the machine");
  expect(Object.values(state().machines)[0]?.state === "stopped", "and the platform's machine is stopped, not left running");
  expect((await computers.wake(ACCOUNT, nodeId, "resume")).state === "waking" && Object.values(state().machines)[0]?.state === "started", "a wake starts it again");
}

async function failuresSurface() {
  const provider = new CommandProvider(command);
  let message = "";
  await provider.run("fail" as never, {}).catch((error: Error) => { message = error.message; });
  expect(/platform said no/.test(message), "a dispatcher's failure reaches the fleet with its own message");
  let refused = false;
  try { new CommandProvider(`${JSON.stringify(process.execPath)} -e "process.exit(1)"`); } catch { refused = true; }
  expect(refused, "a dispatcher that can't describe itself is refused at start");
}

try {
  await run(lifecycleThroughADispatcher, failuresSurface);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
