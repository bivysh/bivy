// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { listenPort, parseLsof } from "../src/apps/listeners.js";
import { AppRegistry } from "../src/apps/registry.js";
import { AppService } from "../src/apps/service.js";
import { createAppCommands } from "../src/controllers/app-commands.js";
import { CommandRegistry } from "../src/protocol/command-registry.js";
import { CLIENT_COMMAND_SCHEMAS } from "../src/protocol/client-command-schemas.js";

/** A real server process, started the way an agent would: cwd in a directory. */
async function server(cwd: string, host = "127.0.0.1"): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, ["-e", `require("http").createServer((q,s)=>s.end("ok")).listen(0,${JSON.stringify(host)},function(){console.log(this.address().port)})`], { cwd, stdio: ["ignore", "pipe", "inherit"] });
  const [chunk] = await once(child.stdout!, "data");
  return { child, port: Number(String(chunk).trim()) };
}

test("only workspace processes listening on loopback or wildcard are offered, and only offers can be adopted", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-offers-"));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-elsewhere-"));
  fs.mkdirSync(path.join(workspace, "web"));
  const inWorkspace = await server(path.join(workspace, "web"));
  const outside = await server(elsewhere);
  try {
    const service = new AppService(new AppRegistry(), undefined, { start: async () => "t", has: () => true, close: () => {} });
    const commands = new CommandRegistry(createAppCommands(service, (id) => id === "s" ? workspace : undefined), CLIENT_COMMAND_SCHEMAS);
    const replies: any[] = []; const broadcasts: any[] = [];
    const ctx = { reply: (event: unknown) => replies.push(event), broadcast: (event: unknown) => broadcasts.push(event) };

    await commands.dispatch("apps.offers", { kind: "apps.offers", sessionId: "s" }, ctx);
    const offered = replies.at(-1).offers.map((offer: { port: number }) => offer.port);
    assert.deepEqual(offered, [inWorkspace.port]);
    assert.equal(replies.at(-1).offers[0].pid, inWorkspace.child.pid);

    // A client can't use adopt to publish a port that isn't a current offer.
    await commands.dispatch("apps.adopt", { kind: "apps.adopt", sessionId: "s", port: outside.port }, ctx);
    assert.equal(replies.at(-1).type, "apps.adopt.error");

    await commands.dispatch("apps.adopt", { kind: "apps.adopt", sessionId: "s", port: inWorkspace.port }, ctx);
    assert.equal(replies.at(-1).type, "apps.adopt.ok");
    assert.equal(broadcasts.at(-1).type, "apps.changed");
    assert.equal(service.list("s").apps[0].views[0].kind, "web");

    // Once previewed, the server stops being offered to this session.
    await commands.dispatch("apps.offers", { kind: "apps.offers", sessionId: "s" }, ctx);
    assert.deepEqual(replies.at(-1).offers, []);
  } finally {
    inWorkspace.child.kill(); outside.child.kill();
    fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("socket tables admit loopback and wildcard listeners only", () => {
  const row = (address: string, state = "0A") => `  0: ${address}:1F90 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000`;
  assert.deepEqual(listenPort(row("0100007F")), { inode: "4242", port: 8080 });
  assert.deepEqual(listenPort(row("00000000")), { inode: "4242", port: 8080 });
  assert.deepEqual(listenPort(row("00000000000000000000000001000000")), { inode: "4242", port: 8080 });
  assert.deepEqual(listenPort(row("0000000000000000FFFF00000100007F")), { inode: "4242", port: 8080 });
  assert.equal(listenPort(row("0A00A8C0")), undefined); // 192.168.0.10
  assert.equal(listenPort(row("0100007F", "01")), undefined); // established, not listening
  assert.deepEqual(parseLsof("p12\ncnode\nn127.0.0.1:5173\nn[::1]:5173\np13\nn*:3000\n"), [{ pid: 12, values: ["127.0.0.1:5173", "[::1]:5173"] }, { pid: 13, values: ["*:3000"] }]);
});
