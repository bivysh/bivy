// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Native tool surface (issue #291): #297 gave Claude a system-prompt hint to
// shell out to `bivy attach`; this is the stronger sibling — a real
// `attach_to_chat` tool registered as an in-process MCP server via the SDK's
// createSdkMcpServer/tool, wired through ClaudeCodeRuntimeOptions.attachToChat.
// These lock in that (a) the tool is only registered when a callback is
// supplied, (b) it's bound to the SPAWNING session's own id (not some other
// concurrent session), and (c) both its success and error paths map to the
// MCP CallToolResult shape correctly.

import assert from "node:assert/strict";
import { ClaudeCodeRuntime, BIVY_ATTACH_MCP_SERVER_NAME, BIVY_ATTACH_TOOL_NAME } from "../src/runtime/claude-code.js";

process.env.ANTHROPIC_API_KEY ||= "test-key-for-preflight";

function makeSdk() {
  const queries: any[] = [];
  const sdk = {
    query({ options }: { prompt: unknown; options: any }) {
      const q = {
        options,
        closed: false,
        close() { this.closed = true; },
        supportedModels: async () => [],
        setModel() {},
        interrupt() {},
        [Symbol.asyncIterator]() {
          let done = false;
          return { next: async () => (done ? { value: undefined, done: true } : ((done = true), { value: undefined, done: true })) };
        },
      };
      queries.push(q);
      return q;
    },
    // Minimal stand-ins for the real SDK's MCP helpers — just enough shape for
    // claude-code.ts's buildAttachMcpServer to compose them and for this test to
    // reach the registered tool's handler.
    tool(name: string, description: string, schema: unknown, handler: (args: any, extra: unknown) => Promise<unknown>) {
      return { name, description, schema, handler };
    },
    createSdkMcpServer({ name, tools }: { name: string; tools: unknown[] }) {
      return { name, tools };
    },
  };
  return { sdk, queries };
}

async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// --- No attachToChat callback -> no tool registered, prompt-hint-only path ---
{
  const { sdk, queries } = makeSdk();
  const runtime = new ClaudeCodeRuntime({ sdkLoader: async () => sdk });
  const { session } = await runtime.createSession({ workspace: process.cwd() });
  await session.prompt("hi");
  await waitFor(() => queries.length === 1);
  assert.equal(queries[0].options.mcpServers, undefined, "no attachToChat callback -> no mcpServers registered");
}

// --- attachToChat callback supplied -> tool registered and bound to this session ---
{
  const { sdk, queries } = makeSdk();
  const calls: Array<{ sessionId: string; opts: { filePath: string; caption?: string } }> = [];
  const attachToChat = (sessionId: string, opts: { filePath: string; caption?: string }) => {
    calls.push({ sessionId, opts });
    if (opts.filePath === "missing.txt") return { error: "File not found" };
    return { ref: { hash: "a".repeat(64), name: "report.pdf", mimeType: "application/pdf", size: 1234, kind: "file" as const } };
  };

  const runtime = new ClaudeCodeRuntime({ sdkLoader: async () => sdk, attachToChat });
  const { session } = await runtime.createSession({ workspace: process.cwd() });
  await session.prompt("send me the report");
  await waitFor(() => queries.length === 1);

  const mcpServers = queries[0].options.mcpServers;
  assert.ok(mcpServers, "attachToChat callback supplied -> mcpServers must be registered");
  const server = mcpServers[BIVY_ATTACH_MCP_SERVER_NAME];
  assert.ok(server, `expected an mcp server named "${BIVY_ATTACH_MCP_SERVER_NAME}"`);
  const tool = server.tools.find((t: any) => t.name === BIVY_ATTACH_TOOL_NAME);
  assert.ok(tool, `expected a "${BIVY_ATTACH_TOOL_NAME}" tool on the mcp server`);
  assert.match(tool.description, /workspace/i, "the tool description should mention the workspace confinement");

  // Success path: the handler must call attachToChat with THIS session's id
  // (not some hardcoded/global one) and report the attached file back.
  const ok = await tool.handler({ filePath: "report.pdf", caption: "here you go" }, {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.sessionId, session.id, "the tool must resolve to the spawning session's own id");
  assert.deepEqual(calls[0]!.opts, { filePath: "report.pdf", caption: "here you go" });
  assert.equal(ok.isError, undefined);
  assert.match(ok.content[0].text, /Attached report\.pdf/);

  // Error path: attachToChat's { error } result must surface as isError, not throw.
  const failed = await tool.handler({ filePath: "missing.txt" }, {});
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /File not found/);
}

console.log("claude attach_to_chat native tool OK");
