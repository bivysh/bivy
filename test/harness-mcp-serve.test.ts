// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// `bivy mcp-serve` — the Bivy-owned stdio MCP server (issue #290). Covers the
// attach client (what it POSTs, the phrasing it returns, never throws) and a full
// Client↔Server round-trip over an in-memory transport (tools/list advertises
// attach_to_chat and the command table's tools; tools/call posts to the node's
// attach endpoint or runs `bivy tool`; the guides are resources).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createBivyMcpServer, runAttachToChat, type RunBivy } from "../src/harness/mcp-serve-cli.js";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

type Captured = { url: string; body: any };
function fakeFetch(status: number, json: unknown, captured: Captured[] = []) {
  return (async (url: string, init: any) => {
    captured.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  }) as never;
}

await check("runAttachToChat posts path+caption to /api/session/:id/attach", async () => {
  const cap: Captured[] = [];
  const r = await runAttachToChat("http://127.0.0.1:4317", "sess-1", { path: "public/logo.svg", caption: "hi" }, fakeFetch(200, { ok: true, name: "logo.svg", kind: "image" }, cap));
  assert.equal(r.isError, false);
  assert.match(r.text, /Attached logo\.svg .*inline image/);
  assert.equal(cap[0]!.url, "http://127.0.0.1:4317/api/session/sess-1/attach");
  assert.deepEqual(cap[0]!.body, { path: "public/logo.svg", caption: "hi" });
});

await check("trailing slash on endpoint does not double up", async () => {
  const cap: Captured[] = [];
  await runAttachToChat("http://127.0.0.1:4317/", "s", { path: "a.pdf" }, fakeFetch(200, { ok: true, name: "a.pdf", kind: "file" }, cap));
  assert.equal(cap[0]!.url, "http://127.0.0.1:4317/api/session/s/attach");
});

await check("a non-image is described as a downloadable file", async () => {
  const r = await runAttachToChat("http://x", "s", { path: "r.pdf" }, fakeFetch(200, { ok: true, name: "r.pdf", kind: "file" }));
  assert.match(r.text, /downloadable file/);
});

await check("a node rejection (e.g. path escaped workspace) is surfaced, not thrown", async () => {
  const r = await runAttachToChat("http://x", "s", { path: "/etc/passwd" }, fakeFetch(400, { error: "Path is outside the session workspace" }));
  assert.equal(r.isError, true);
  assert.match(r.text, /outside the session workspace/);
});

await check("missing session id fails fast with no network call", async () => {
  const cap: Captured[] = [];
  const r = await runAttachToChat("http://x", "", { path: "a" }, fakeFetch(200, {}, cap));
  assert.equal(r.isError, true);
  assert.equal(cap.length, 0);
});

await check("a transport failure is caught and reported", async () => {
  const r = await runAttachToChat("http://x", "s", { path: "a" }, (async () => { throw new Error("ECONNREFUSED"); }) as never);
  assert.equal(r.isError, true);
  assert.match(r.text, /Could not reach the Bivy node/);
});

// A stand-in for the CLI: one table tool, and whatever a `bivy tool` call returns.
function fakeCli(calls: string[][], reply = { code: 0, stdout: '{"ok":true,"push":"sent"}', stderr: "" }): RunBivy {
  return async (args) => {
    calls.push(args);
    if (args[0] === "help") return { code: 0, stdout: JSON.stringify({ tools: [{ name: "notify_user", description: "Message the user.", inputSchema: { type: "object", properties: { message: { type: "string" } } }, argv: ["notify"] }] }), stderr: "" };
    return reply;
  };
}

await check("round-trip: a real MCP client lists + calls attach_to_chat", async () => {
  const cap: Captured[] = [];
  const server = createBivyMcpServer({ endpoint: "http://127.0.0.1:4317", sessionId: "sess-9", fetchImpl: fakeFetch(200, { ok: true, name: "chart.png", kind: "image" }, cap), runBivy: fakeCli([]) });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientT);

  const list = await client.listTools();
  assert.deepEqual(list.tools.map((t) => t.name), ["attach_to_chat", "notify_user"]);

  const res: any = await client.callTool({ name: "attach_to_chat", arguments: { path: "out/chart.png" } });
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /Attached chart\.png/);
  assert.equal(cap[0]!.url, "http://127.0.0.1:4317/api/session/sess-9/attach");
  assert.deepEqual(cap[0]!.body, { path: "out/chart.png" }); // undefined caption is omitted by JSON.stringify

  const bad: any = await client.callTool({ name: "nope", arguments: {} });
  assert.equal(bad.isError, true);
  await client.close();
});

await check("a command-table tool runs as `bivy tool`, and its failure reaches the agent", async () => {
  const calls: string[][] = [];
  const connect = async (runBivy: RunBivy) => {
    const server = createBivyMcpServer({ sessionId: "sess-1", runBivy });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientT);
    return client;
  };
  const client = await connect(fakeCli(calls));
  const ok: any = await client.callTool({ name: "notify_user", arguments: { message: "Done" } });
  assert.equal(ok.isError, false);
  assert.match(ok.content[0].text, /"push":"sent"/);
  assert.deepEqual(calls.at(-1), ["tool", "notify_user", '{"message":"Done"}']);
  await client.close();
  const failing = await connect(fakeCli([], { code: 3, stdout: "", stderr: '{"error":{"code":"session_not_found","message":"Session s is not open on this node."}}' }));
  const bad: any = await failing.callTool({ name: "notify_user", arguments: { message: "Done" } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /session_not_found/);
  await failing.close();
});

await check("the real CLI supplies the tools and serves the guides as resources", async () => {
  const server = createBivyMcpServer({ sessionId: "sess-1" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientT);
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const name of ["notify_user", "ask_user", "suggest_task", "app_present", "bivy_context"]) assert.ok(names.includes(name), `${name} is offered`);
  assert.ok(!names.some((name) => /delegate|runs/.test(name)), "delegation and Runs stay shell-only");
  const resources = (await client.listResources()).resources.map((r) => r.uri);
  assert.ok(resources.includes("bivy://guide/talk-to-the-user"));
  const guide: any = await client.readResource({ uri: "bivy://guide/talk-to-the-user" });
  assert.match(guide.contents[0].text, /bivy notify/);
  await client.close();
});

await check("the user's account-wide instructions are advertised as MCP server instructions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-mcp-instr-"));
  const file = path.join(dir, "composed.md");
  fs.writeFileSync(file, "Prefer small commits.\n");
  const connect = async (instructionsFile: string) => {
    const server = createBivyMcpServer({ sessionId: "sess-1", instructionsFile, runBivy: fakeCli([]) });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientT);
    const instructions = client.getInstructions();
    await client.close();
    return instructions;
  };
  assert.equal(await connect(file), "Prefer small commits.");
  // A cleared (removed) file means no instructions, not an error.
  assert.equal(await connect(path.join(dir, "missing.md")), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

if (failures > 0) {
  console.error(`\n${failures} mcp-serve test(s) failed`);
  process.exit(1);
}
console.log("\nall mcp-serve tests passed");
