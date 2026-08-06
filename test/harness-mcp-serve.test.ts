// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// `bivy mcp-serve` — the Bivy-owned stdio MCP server (issue #290). Covers the
// attach client (what it POSTs, the phrasing it returns, never throws) and a full
// Client↔Server round-trip over an in-memory transport (tools/list advertises
// attach_to_chat; tools/call posts to the node's attach endpoint).

import assert from "node:assert/strict";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { BIVY_MCP_TOOLS, createBivyMcpServer, runAttachToChat } from "../src/harness/mcp-serve-cli.js";

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
    captured.push({ url, body: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  }) as never;
}

await check("advertises the attach_to_chat tool with a required path", () => {
  assert.equal(BIVY_MCP_TOOLS.length, 1);
  assert.equal(BIVY_MCP_TOOLS[0]!.name, "attach_to_chat");
  assert.deepEqual(BIVY_MCP_TOOLS[0]!.inputSchema.required, ["path"]);
});

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

await check("round-trip: a real MCP client lists + calls attach_to_chat", async () => {
  const cap: Captured[] = [];
  const server = createBivyMcpServer({ endpoint: "http://127.0.0.1:4317", sessionId: "sess-9", fetchImpl: fakeFetch(200, { ok: true, name: "chart.png", kind: "image" }, cap) });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientT);

  const list = await client.listTools();
  assert.deepEqual(list.tools.map((t) => t.name), ["attach_to_chat"]);

  const res: any = await client.callTool({ name: "attach_to_chat", arguments: { path: "out/chart.png" } });
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /Attached chart\.png/);
  assert.equal(cap[0]!.url, "http://127.0.0.1:4317/api/session/sess-9/attach");
  assert.deepEqual(cap[0]!.body, { path: "out/chart.png" }); // undefined caption is omitted by JSON.stringify

  const bad: any = await client.callTool({ name: "nope", arguments: {} });
  assert.equal(bad.isError, true);
  await client.close();
});

if (failures > 0) {
  console.error(`\n${failures} mcp-serve test(s) failed`);
  process.exit(1);
}
console.log("\nall mcp-serve tests passed");
