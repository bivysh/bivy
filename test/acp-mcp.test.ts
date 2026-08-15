// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";

import { acpMcpServer, acpMcpServersFromConfig, serializeAcpMcpEnv } from "../src/runtime/acp-mcp.js";

test("stdio server maps command/args and env-as-array", () => {
  const mapped = acpMcpServer("bivy", { command: "bivy", args: ["mcp-serve"], env: { BIVY_MCP_TOKEN: "t" } });
  assert.deepEqual(mapped, { name: "bivy", command: "bivy", args: ["mcp-serve"], env: [{ name: "BIVY_MCP_TOKEN", value: "t" }] });
});

test("stdio server without env omits the env key; missing args default to []", () => {
  assert.deepEqual(acpMcpServer("x", { command: "x" }), { name: "x", command: "x", args: [] });
});

test("remote server maps url + type (defaulting to http)", () => {
  assert.deepEqual(acpMcpServer("r", { url: "https://h/mcp" }), { name: "r", url: "https://h/mcp", type: "http" });
  assert.deepEqual(acpMcpServer("r", { url: "https://h/sse", type: "sse" }), { name: "r", url: "https://h/sse", type: "sse" });
});

test("a spec that is neither stdio nor remote is dropped", () => {
  assert.equal(acpMcpServer("empty", {} as any), null);
});

test("full config maps the whole map and drops unrunnable entries", () => {
  const out = acpMcpServersFromConfig({
    mcpServers: {
      bivy: { command: "bivy", args: ["mcp-serve"] },
      remote: { url: "https://h/mcp" },
      broken: {} as any,
    },
  });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => s.name).sort(), ["bivy", "remote"]);
});

test("serializeAcpMcpEnv returns undefined when there is nothing to advertise", () => {
  assert.equal(serializeAcpMcpEnv(undefined), undefined);
  assert.equal(serializeAcpMcpEnv({ mcpServers: {} }), undefined);
  assert.equal(serializeAcpMcpEnv({ mcpServers: { broken: {} as any } }), undefined);
});

test("serializeAcpMcpEnv round-trips through JSON for a populated config", () => {
  const env = serializeAcpMcpEnv({ mcpServers: { bivy: { command: "bivy", args: [] } } });
  assert.ok(env);
  assert.deepEqual(JSON.parse(env!), [{ name: "bivy", command: "bivy", args: [] }]);
});
