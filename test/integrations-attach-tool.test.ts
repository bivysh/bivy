// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Native tool surface (issue #291), Pi side: IntegrationManager already exposes
// connected integrations' tools as a runtime-agnostic ToolProvider that Pi
// registers verbatim (src/runtime/pi.ts's toolProviderFactory). This adds an
// always-on `attach_to_chat` tool to that same ToolProvider — no "connect" flow,
// gated only on the daemon having wired an attachToChat callback — backed by the
// same server-side attachToChat() helper the Claude tool and the CLI use.
//
// The tricky part these tests lock in: toolProvider() is built BEFORE the
// specific session it will serve exists (see SessionIdRef's doc), so the tool
// must resolve the session id lazily through the ref the caller fills in later,
// not at registration time.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { IntegrationManager, type SessionIdRef } from "../src/integrations/index.js";
import { ATTACH_TO_CHAT_TOOL } from "../src/integrations/registry.js";
import type { AttachToChatFn } from "../src/runtime/types.js";

function tmpAppDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bivy-attach-tool-"));
}

test("no attachToChat callback -> attach_to_chat is not offered", () => {
  const manager = new IntegrationManager(tmpAppDir());
  const provider = manager.toolProvider({ current: "s-1" });
  assert.equal(provider.list().find((s) => s.name === ATTACH_TO_CHAT_TOOL.name), undefined);
});

test("attachToChat callback but no sessionIdRef -> attach_to_chat is not offered", () => {
  const attachToChat: AttachToChatFn = () => ({ error: "should not be called" });
  const manager = new IntegrationManager(tmpAppDir(), undefined, attachToChat);
  const provider = manager.toolProvider();
  assert.equal(provider.list().find((s) => s.name === ATTACH_TO_CHAT_TOOL.name), undefined);
});

test("attachToChat wired -> attach_to_chat is offered and resolves the session lazily", async () => {
  const calls: Array<{ sessionId: string; opts: unknown }> = [];
  const attachToChat: AttachToChatFn = (sessionId, opts) => {
    calls.push({ sessionId, opts });
    return { ref: { hash: "b".repeat(64), name: "chart.png", mimeType: "image/png", size: 42, kind: "image" } };
  };
  const manager = new IntegrationManager(tmpAppDir(), undefined, attachToChat);

  // Mirrors the real call sites in server.ts: the ref is built (and handed to
  // toolProvider) before the session id is known, and filled in shortly after.
  const sessionIdRef: SessionIdRef = {};
  const provider = manager.toolProvider(sessionIdRef);

  const spec = provider.list().find((s) => s.name === ATTACH_TO_CHAT_TOOL.name);
  assert.ok(spec, "attach_to_chat must be offered once a callback is wired");
  assert.match(spec!.description ?? "", /workspace/i);

  // Before the session id is known, the tool must fail cleanly, not throw or hang.
  const early = await provider.invoke(ATTACH_TO_CHAT_TOOL.name, "call-1", { filePath: "chart.png" });
  assert.equal(early.isError, true);
  assert.equal(calls.length, 0, "attachToChat must not run before the session id is resolved");

  // Once the caller fills the ref in (as server.ts does right after
  // runtimeHost.createSession resolves), the same provider instance picks it up.
  sessionIdRef.current = "s-42";
  const result = await provider.invoke(ATTACH_TO_CHAT_TOOL.name, "call-2", { filePath: "chart.png", caption: "trend" });
  assert.equal(result.isError, undefined);
  assert.match(result.content?.[0]?.text ?? "", /Attached chart\.png/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.sessionId, "s-42");
  assert.deepEqual(calls[0]!.opts, { filePath: "chart.png", caption: "trend" });
});

test("attach_to_chat surfaces attachToChat's { error } result as an error tool result", async () => {
  const attachToChat: AttachToChatFn = () => ({ error: "Path escapes the session workspace" });
  const manager = new IntegrationManager(tmpAppDir(), undefined, attachToChat);
  const provider = manager.toolProvider({ current: "s-1" });

  const result = await provider.invoke(ATTACH_TO_CHAT_TOOL.name, "call-1", { filePath: "../outside.txt" });
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /escapes the session workspace/);
});

test("attach_to_chat rejects a missing filePath without calling attachToChat", async () => {
  let ran = false;
  const attachToChat: AttachToChatFn = () => { ran = true; return { error: "unreachable" }; };
  const manager = new IntegrationManager(tmpAppDir(), undefined, attachToChat);
  const provider = manager.toolProvider({ current: "s-1" });

  const result = await provider.invoke(ATTACH_TO_CHAT_TOOL.name, "call-1", {});
  assert.equal(result.isError, true);
  assert.equal(ran, false);
});
