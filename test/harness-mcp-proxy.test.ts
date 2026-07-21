import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { McpMediator, runMcpProxy, type McpEvent } from "../src/harness/mcp-proxy.js";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

async function main() {
  await check("allow: tools/call is forwarded unchanged", async () => {
    const events: McpEvent[] = [];
    const m = new McpMediator({ decide: () => ({ allow: true }), onEvent: (e) => events.push(e), server: "fs" });
    const msg = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/x" } } };
    const out = await m.handleClientMessage(msg);
    assert.equal(out.forward, msg);
    assert.equal(out.reply, undefined);
    assert.deepEqual(events, [{ type: "call", server: "fs", tool: "read_file", args: { path: "/x" }, allowed: true, reason: undefined }]);
  });

  await check("deny: tools/call is short-circuited as an isError result", async () => {
    const m = new McpMediator({ decide: () => ({ allow: false, reason: "nope" }), server: "fs" });
    const out = await m.handleClientMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "rm", arguments: {} } });
    assert.equal(out.forward, undefined);
    assert.ok(out.reply);
    assert.equal(out.reply!.id, 7);
    const result = out.reply!.result as { isError: boolean; content: { text: string }[] };
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "nope");
    assert.equal(m.wasDenied(7), true);
  });

  await check("policy exception fails safe (deny)", async () => {
    const m = new McpMediator({ decide: () => { throw new Error("boom"); } });
    const out = await m.handleClientMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } });
    assert.ok(out.reply);
    assert.equal((out.reply!.result as { isError: boolean }).isError, true);
  });

  await check("non tools/call requests pass through untouched", async () => {
    const m = new McpMediator({ decide: () => ({ allow: false }) });
    for (const method of ["initialize", "tools/list", "resources/read", "ping"]) {
      const msg = { jsonrpc: "2.0", id: 1, method };
      const out = await m.handleClientMessage(msg);
      assert.equal(out.forward, msg, `${method} should forward`);
      assert.equal(out.reply, undefined);
    }
  });

  await check("server tools/list result is inventoried", async () => {
    const events: McpEvent[] = [];
    const m = new McpMediator({ decide: () => ({ allow: true }), onEvent: (e) => events.push(e), server: "fs" });
    m.handleServerMessage({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "read_file", description: "read" }, { name: "write_file" }, { bad: true }] } });
    const inv = events.find((e) => e.type === "tools");
    assert.ok(inv && inv.type === "tools");
    assert.deepEqual((inv as any).tools, [{ name: "read_file", description: "read" }, { name: "write_file", description: undefined }]);
  });

  await check("server tool result logs isError status", async () => {
    const events: McpEvent[] = [];
    const m = new McpMediator({ decide: () => ({ allow: true }), onEvent: (e) => events.push(e) });
    m.handleServerMessage({ jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: "ok" }] } });
    m.handleServerMessage({ jsonrpc: "2.0", id: 6, result: { isError: true, content: [] } });
    const results = events.filter((e) => e.type === "result");
    assert.equal(results.length, 2);
    assert.equal((results[0] as any).isError, false);
    assert.equal((results[1] as any).isError, true);
  });

  // End-to-end: drive the real runMcpProxy in-process (injected streams) against
  // a fast `node -e` fake MCP server. A denied call must never reach the server.
  await check("e2e: proxy forwards an allowed call and blocks a denied one", async () => {
    const fakeServer = `
      const { createInterface } = require("node:readline");
      const rl = createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const t = line.trim(); if (!t) return;
        const msg = JSON.parse(t);
        if (msg.method === "tools/call") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "SERVER_RAN:" + msg.params.name }] } }) + "\\n");
        }
      });
    `;
    const agentInput = new PassThrough();
    const agentOutput = new PassThrough();
    const outLines: string[] = [];
    const rl = createInterface({ input: agentOutput });
    rl.on("line", (l) => { if (l.trim()) outLines.push(l.trim()); });

    const done = runMcpProxy({
      command: process.execPath,
      args: ["-e", fakeServer],
      decide: (tool) => ({ allow: tool !== "danger", reason: "blocked " + tool }),
      server: "fake",
      agentInput,
      agentOutput,
    });

    const send = (o: unknown) => agentInput.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "danger", arguments: {} } });

    await waitFor(() => outLines.length >= 2, 8000);
    agentInput.end(); // closes child stdin → fake server exits → runMcpProxy resolves
    await done;

    const byId = new Map<number, any>();
    for (const l of outLines) { const m = JSON.parse(l); byId.set(m.id, m); }
    assert.equal(byId.get(1).result.content[0].text, "SERVER_RAN:echo", "allowed call must reach the real server");
    assert.equal(byId.get(2).result.isError, true, "denied call must be short-circuited");
    assert.equal(byId.get(2).result.content[0].text, "blocked danger");
  });

  if (failures > 0) {
    console.error(`\n${failures} mcp-proxy test(s) failed`);
    process.exit(1);
  }
  console.log("\nall mcp-proxy tests passed");
}

function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout waiting for proxy output"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

void main();
