// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// The shared `attach_to_chat` tool core (src/harness/attach-tool.ts): it POSTs to
// the node's attach endpoint and turns the reply into an agent-facing result.
// These lock in the URL/body it sends, the success/failure phrasing, and that it
// never throws (a down node / bad path comes back as isError text, not a crash).

import assert from "node:assert/strict";
import {
  runAttachTool,
  ATTACH_TOOL_NAME,
  ATTACH_TOOL_DESCRIPTION,
  attachToolInputSchema,
} from "../src/harness/attach-tool.js";

type Captured = { url: string; body: any; headers: Record<string, string> };

function fakeFetch(status: number, json: unknown, captured: Captured[]): typeof fetch {
  return (async (url: string, init: any) => {
    captured.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    } as Response;
  }) as unknown as typeof fetch;
}

// Metadata sanity — the name is stable and the description names the capability.
assert.equal(ATTACH_TOOL_NAME, "attach_to_chat");
assert.match(ATTACH_TOOL_DESCRIPTION, /image renders inline/i);
assert.deepEqual(Object.keys(attachToolInputSchema.shape).sort(), ["caption", "path"]);

// Happy path: posts to /api/session/:id/attach with the path + caption, and
// reports an inline image back to the agent.
{
  const cap: Captured[] = [];
  const r = await runAttachTool({
    endpoint: "http://127.0.0.1:4317",
    sessionId: "sess-1",
    path: "public/logo.svg",
    caption: "the logo",
    fetchImpl: fakeFetch(200, { ok: true, name: "logo.svg", kind: "image" }, cap),
  });
  assert.equal(r.isError, false);
  assert.match(r.text, /Attached logo\.svg .*inline image/);
  assert.equal(cap.length, 1);
  assert.equal(cap[0]!.url, "http://127.0.0.1:4317/api/session/sess-1/attach");
  assert.deepEqual(cap[0]!.body, { path: "public/logo.svg", caption: "the logo" });
}

// A non-image is described as a downloadable file.
{
  const cap: Captured[] = [];
  const r = await runAttachTool({
    endpoint: "http://127.0.0.1:4317/", // trailing slash tolerated
    sessionId: "sess-1",
    path: "report.pdf",
    fetchImpl: fakeFetch(200, { ok: true, name: "report.pdf", kind: "file" }, cap),
  });
  assert.equal(r.isError, false);
  assert.match(r.text, /downloadable file/);
  assert.equal(cap[0]!.url, "http://127.0.0.1:4317/api/session/sess-1/attach"); // no double slash
}

// Node rejects (e.g. path escaped the workspace): surfaced as isError with the
// node's message, never thrown.
{
  const cap: Captured[] = [];
  const r = await runAttachTool({
    endpoint: "http://127.0.0.1:4317",
    sessionId: "sess-1",
    path: "/etc/passwd",
    fetchImpl: fakeFetch(400, { error: "Path is outside the session workspace" }, cap),
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /outside the session workspace/);
}

// A missing session id fails fast without a network call.
{
  const cap: Captured[] = [];
  const r = await runAttachTool({ endpoint: "http://127.0.0.1:4317", sessionId: "", path: "x", fetchImpl: fakeFetch(200, {}, cap) });
  assert.equal(r.isError, true);
  assert.match(r.text, /No active Bivy session/);
  assert.equal(cap.length, 0);
}

// A transport failure (node down) is caught and reported, not thrown.
{
  const r = await runAttachTool({
    endpoint: "http://127.0.0.1:4317",
    sessionId: "sess-1",
    path: "x",
    fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /Could not reach the Bivy node/);
}

console.log("attach_to_chat tool core OK");
