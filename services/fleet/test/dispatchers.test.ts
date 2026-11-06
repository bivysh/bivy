// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The platform dispatchers in dispatchers/, each run as a real process through
// the `command` provider against a stand-in for its platform's API. What this
// pins: a machine is created labelled for its app, the boot payload is
// written, the node is started detached, a start runs the boot again, and
// stop and delete reach the platform. It follows each platform's documented
// API; it does not prove the platform behaves as documented.
import { execFileSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommandProvider } from "../src/dispatch.js";
import { expect, run } from "./harness.js";
import type { MachineSpec } from "../src/provider.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dispatcher = (name: string) => `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(here, "..", "dispatchers", `${name}.mjs`))}`;

const spec: MachineSpec = {
  region: "iad", image: "registry/bivy-runner:1", size: "shared-4x-8gb", volumeId: "", metadata: {},
  files: [{ guest_path: "/etc/bivy/relay.json", raw_value: Buffer.from('{"nodeId":"n1"}').toString("base64") }],
  init: { exec: ["/usr/bin/timeout", "60", "/bin/bash", "-c", "echo \"it's up\""] },
};

type Seen = { method: string; path: string; body: Buffer; headers: http.IncomingHttpHeaders };

async function standIn(answer: (req: Seen) => unknown) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const call = { method: req.method ?? "", path: req.url ?? "", body: Buffer.concat(chunks), headers: req.headers };
      seen.push(call);
      const out = answer(call);
      if (Buffer.isBuffer(out)) { res.end(out); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { seen, url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = { ...process.env };
  Object.assign(process.env, env);
  try { return await fn(); } finally { process.env = before; }
}

async function daytona() {
  let state = "started";
  const platform = await standIn((call) => {
    if (call.method === "POST" && call.path === "/sandbox") return { id: "sb1", state: "creating", target: "us" };
    if (call.method === "GET" && call.path === "/sandbox/sb1") return { id: "sb1", state, toolboxProxyUrl: `${platform.url}/toolbox` };
    if (call.path === "/sandbox/sb1/stop") { state = "stopped"; return {}; }
    if (call.path === "/sandbox/sb1/start") { state = "started"; return {}; }
    if (call.method === "GET" && call.path.startsWith("/sandbox?labels=")) return { items: [{ id: "sb1", labels: { "bivy-app": "app-1" } }] };
    return {};
  });
  try {
    await withEnv({ DAYTONA_API_KEY: "dk", DAYTONA_API_URL: platform.url }, async () => {
      const provider = new CommandProvider(dispatcher("daytona"));
      expect(!provider.capabilities.stopsOnExit, "Daytona: the fleet stops sandboxes itself");
      const machine = await provider.createMachine("app-1", spec);
      const create = JSON.parse(platform.seen.find((c) => c.method === "POST" && c.path === "/sandbox")!.body.toString());
      expect(machine.id === "sb1" && create.labels["bivy-app"] === "app-1" && create.autoStopInterval === 0 && create.user === "root", "Daytona: a labelled root sandbox with auto-stop off");
      expect(create.buildInfo?.dockerfileContent === "FROM registry/bivy-runner:1\n" && create.cpu === 4 && create.memory === 8, "Daytona: built from the fleet's image at the fleet's size");
      const uploads = platform.seen.filter((c) => c.path.startsWith("/toolbox/sb1/files/upload-v2"));
      expect(uploads.some((c) => c.path.includes(encodeURIComponent("/etc/bivy/relay.json"))) && uploads.some((c) => c.path.includes(encodeURIComponent("/etc/bivy/boot.sh"))), "Daytona: the boot payload and boot script are written");
      const execs = () => platform.seen.filter((c) => /\/process\/session\/[^/]+\/exec$/.test(c.path)).map((c) => JSON.parse(c.body.toString()));
      expect(execs().length === 1 && execs()[0].runAsync === true && /nohup bash \/etc\/bivy\/boot\.sh/.test(execs()[0].command), "Daytona: the node is started detached");
      await provider.stopMachine("app-1", "sb1");
      expect((await provider.getMachine("app-1", "sb1"))?.state === "stopped", "Daytona: stop reaches the sandbox");
      await provider.startMachine("app-1", "sb1");
      expect(execs().length === 2, "Daytona: a start runs the boot again");
      await provider.destroyAll("app-1");
      expect(platform.seen.some((c) => c.method === "DELETE" && c.path === "/sandbox/sb1"), "Daytona: deleting an app deletes its sandboxes");
    });
  } finally {
    await platform.close();
  }
}

/** One Connect end-of-stream frame (flags 2), as envd ends a stream. */
const endFrame = (payload: unknown) => {
  const body = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(5 + body.length);
  frame.writeUInt8(2, 0);
  frame.writeUInt32BE(body.length, 1);
  body.copy(frame, 5);
  return frame;
};

async function e2b() {
  let state = "running";
  const platform = await standIn((call) => {
    if (call.method === "POST" && call.path === "/v2/sandboxes") return { sandboxID: "e1", envdAccessToken: "tok", templateID: "bivy" };
    if (call.path === "/process.Process/Start") return endFrame({});
    if (call.method === "GET" && call.path === "/sandboxes/e1") return { sandboxID: "e1", state };
    if (call.path === "/sandboxes/e1/pause") { state = "paused"; return {}; }
    if (call.path === "/v2/sandboxes/e1/connect") { state = "running"; return { sandboxID: "e1", envdAccessToken: "tok2" }; }
    if (call.method === "GET" && call.path.startsWith("/v2/sandboxes?metadata=")) return [{ sandboxID: "e1", metadata: { "bivy-app": "app-1" } }];
    return {};
  });
  try {
    await withEnv({ E2B_API_KEY: "ek", E2B_TEMPLATE: "bivy", E2B_API_URL: platform.url, E2B_ENVD_URL: platform.url }, async () => {
      const provider = new CommandProvider(dispatcher("e2b"));
      const machine = await provider.createMachine("app-1", spec);
      const create = JSON.parse(platform.seen.find((c) => c.path === "/v2/sandboxes")!.body.toString());
      expect(machine.id === "e1" && create.templateID === "bivy" && create.metadata["bivy-app"] === "app-1" && create.autoPause === true, "E2B: a labelled sandbox from the template that pauses, not dies, at its timeout");
      const files = platform.seen.filter((c) => c.path.startsWith("/files?"));
      expect(files.length === 2 && files.every((c) => c.headers["e2b-sandbox-id"] === "e1" && c.headers["x-access-token"] === "tok"), "E2B: the boot payload is written through envd with the sandbox's token");
      const starts = () => platform.seen.filter((c) => c.path === "/process.Process/Start");
      const message = JSON.parse(starts()[0].body.subarray(5).toString());
      expect(starts()[0].body.readUInt32BE(1) === starts()[0].body.length - 5 && /nohup bash \/etc\/bivy\/boot\.sh/.test(message.process.args[1]), "E2B: the node is started detached, in a framed Connect request");
      await provider.stopMachine("app-1", "e1");
      expect((await provider.getMachine("app-1", "e1"))?.state === "stopped", "E2B: stop pauses the sandbox");
      await provider.startMachine("app-1", "e1");
      expect(starts().length === 2 && starts()[1].headers["x-access-token"] === "tok2", "E2B: a start resumes it and runs the boot again with the fresh token");
      await provider.destroyAll("app-1");
      expect(platform.seen.some((c) => c.method === "DELETE" && c.path === "/sandboxes/e1"), "E2B: deleting an app kills its sandboxes");
    });
  } finally {
    await platform.close();
  }
}

async function sprites() {
  let status = "running";
  const platform = await standIn((call) => {
    if (call.method === "POST" && call.path === "/v1/sprites") return { name: JSON.parse(call.body.toString()).name, status: "running" };
    if (call.method === "GET" && call.path.startsWith("/v1/sprites?")) return { sprites: [{ name: "app-1--abc123" }, { name: "other--zzz" }], has_more: false };
    if (call.method === "GET" && call.path.startsWith("/v1/sprites/")) return { status };
    if (call.path.endsWith("/services/bivy/stop")) { status = "warm"; return {}; }
    if (call.path.endsWith("/services/bivy/start")) { status = "running"; return {}; }
    return {};
  });
  try {
    await withEnv({ SPRITES_TOKEN: "org/id/secret", SPRITES_API_URL: platform.url }, async () => {
      const provider = new CommandProvider(dispatcher("sprites"));
      const machine = await provider.createMachine("app-1", spec);
      expect(/^app-1--[a-z0-9]+$/.test(machine.id), "Sprites: a sprite named for its app");
      const writes = platform.seen.filter((c) => c.method === "PUT" && c.path.includes("/fs/write?"));
      expect(writes.some((c) => c.path.includes(encodeURIComponent("/etc/bivy/boot.sh"))) && writes.length === 2, "Sprites: the boot payload and boot script are written");
      const defined = platform.seen.find((c) => c.method === "PUT" && c.path.endsWith("/services/bivy"));
      expect(JSON.parse(defined!.body.toString()).args[0] === "/etc/bivy/boot.sh" && platform.seen.some((c) => c.path.endsWith("/services/bivy/start")), "Sprites: the node is a service, started now and at every boot");
      await provider.stopMachine("app-1", machine.id);
      expect((await provider.getMachine("app-1", machine.id))?.state === "stopped", "Sprites: stopping the service lets the sprite pause");
      await provider.startMachine("app-1", machine.id);
      expect((await provider.getMachine("app-1", machine.id))?.state === "started", "Sprites: starting it wakes the sprite");
      expect(JSON.stringify(await provider.listApps("app-")) === JSON.stringify(["app-1"]), "Sprites: apps are found by name prefix");
      await provider.destroyAll("app-1");
      expect(platform.seen.some((c) => c.method === "DELETE" && c.path === "/v1/sprites/app-1--abc123"), "Sprites: deleting an app deletes its sprites");
    });
  } finally {
    await platform.close();
  }
}

async function bootScriptRunsTheCommand() {
  const { bootScript } = await import("../dispatchers/common.mjs" as string) as { bootScript: (s: MachineSpec) => string };
  const out = execFileSync("bash", ["-c", bootScript(spec)], { encoding: "utf8" });
  expect(out.trim() === "it's up", "the boot script runs the fleet's command exactly, quotes and all");
}

await run(daytona, e2b, sprites, bootScriptRunsTheCommand);
