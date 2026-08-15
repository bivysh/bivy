// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";

import { createGithubCommands, type GithubCommandDeps } from "../src/controllers/github-commands.js";

function harness(over: Partial<GithubCommandDeps> = {}) {
  const events: any[] = [];
  const disconnects: any[] = [];
  const deps: GithubCommandDeps = {
    sendEvent: (e) => events.push(e),
    startGithubConnect: async () => ({ phase: "pending", userCode: "ABCD" }),
    pollGithubConnect: async () => ({ phase: "connected", login: "octo" }),
    startAppManifest: async () => ({ postUrl: "https://github.com/x", state: "s" }),
    completeAppManifest: async () => ({ installUrl: "https://github.com/i", appId: "42" }),
    connectExistingApp: async () => ({ installUrl: "https://github.com/i", appId: "42", webhookUrl: "w", webhookSecret: "s" }),
    disconnectGithubApp: (input) => disconnects.push(input),
    ...over,
  };
  return { events, disconnects, cmds: createGithubCommands(deps) };
}
const CTX = { reply: () => {} } as any;

test("registers the github cluster", () => {
  assert.deepEqual(Object.keys(harness().cmds).sort(), [
    "github.app.connect-existing", "github.app.disconnect", "github.app.manifest.code", "github.app.manifest.start",
    "github.connect.start", "github.connect.poll",
  ].sort());
});

test("connect start/poll answer with a single github.connect.status shape", async () => {
  const { events, cmds } = harness();
  await (cmds["github.connect.start"] as any)({ kind: "github.connect.start" }, CTX);
  await (cmds["github.connect.poll"] as any)({ kind: "github.connect.poll" }, CTX);
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.type === "github.connect.status"));
  assert.equal(events[0].userCode, "ABCD");
  assert.equal(events[1].login, "octo");
});

test("manifest.start emits ready, and surfaces failures as manifest.error", async () => {
  const ok = harness();
  await (ok.cmds["github.app.manifest.start"] as any)({ kind: "github.app.manifest.start", origin: "https://app", requestId: "r1" }, CTX);
  assert.ok(ok.events.find((e) => e.type === "github.app.manifest.ready" && e.requestId === "r1"));

  const bad = harness({ startAppManifest: async () => { throw new Error("gh down"); } });
  await (bad.cmds["github.app.manifest.start"] as any)({ kind: "github.app.manifest.start", origin: "x" }, CTX);
  assert.match(bad.events.find((e) => e.type === "github.app.manifest.error")?.error ?? "", /gh down/);
});

test("connect-existing reuses the manifest.done/error events", async () => {
  const { events, cmds } = harness();
  await (cmds["github.app.connect-existing"] as any)({ kind: "github.app.connect-existing", appId: "42", privateKeyPem: "-----", requestId: "r2" }, CTX);
  assert.ok(events.find((e) => e.type === "github.app.manifest.done" && e.appId === "42"));
});

test("disconnect scopes to appId/hookId and confirms", async () => {
  const { events, disconnects, cmds } = harness();
  (cmds["github.app.disconnect"] as any)({ kind: "github.app.disconnect", appId: "42", requestId: "r3" }, CTX);
  assert.deepEqual(disconnects[0], { appId: "42", hookId: undefined });
  assert.ok(events.find((e) => e.type === "github.app.disconnected" && e.ok === true && e.appId === "42"));

  const all = harness();
  (all.cmds["github.app.disconnect"] as any)({ kind: "github.app.disconnect" }, CTX);
  assert.deepEqual(all.disconnects[0], { appId: undefined, hookId: undefined }, "both omitted → disconnect all");
});
