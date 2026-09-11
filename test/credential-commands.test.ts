// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCredentialCommands, type CredentialCommandDeps } from "../src/controllers/credential-commands.js";
import { createCredentialVault } from "../src/runtime/credential-store.js";

// The credential functions operate on a real credsDir, so these drive the
// controller against a temp store — exercising the wiring end to end, not mocks.
function harness(over: Partial<CredentialCommandDeps> = {}) {
  const events: any[] = [];
  const broadcasts: any[] = [];
  const calls = { pushed: 0, refreshed: 0 };
  // credentials.config.json intentionally lives beside the vault directory.
  // Give each harness an isolated parent too; using a mkdtemp directory as the
  // vault itself would make every test share /tmp/credentials.config.json.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-creds-"));
  const credsDir = path.join(dataDir, "credentials");
  const deps: CredentialCommandDeps = {
    credsDir,
    sendEvent: (e) => events.push(e),
    broadcast: (e) => broadcasts.push(e),
    pushModelAuthToControlPlane: async () => { calls.pushed++; },
    refreshSessionAfterAuth: async () => { calls.refreshed++; },
    listProvidersUnified: async () => [{ id: "openai" }],
    ...over,
  };
  const replies: any[] = [];
  const ctx = { reply: (e: unknown) => replies.push(e) } as any;
  return { events, broadcasts, replies, calls, credsDir, ctx, cmds: createCredentialCommands(deps), cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test("registers the full credential command cluster", () => {
  const h = harness();
  try {
    assert.deepEqual(Object.keys(h.cmds).sort(), [
      "credential.remove", "credential.set", "credential.sync.set", "credential.test", "credential.unattended.set",
      "credentials.account.export", "credentials.account.import", "credentials.list", "credentials.native.import", "credentials.native.preview", "credentials.presets.get", "credentials.presets.setActive", "credentials.presets.setMapping",
    ]);
  } finally { h.cleanup(); }
});

test("native preview and import stay secret-free, consent-scoped and bound to the source login", async () => {
  const h = harness();
  const home = path.join(h.credsDir, "native-codex");
  const savedEnv = Object.fromEntries(["CODEX_HOME", "HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME"].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(savedEnv)) process.env[key] = home;
  fs.mkdirSync(home, { recursive: true });
  const secret = "native-secret-must-not-leave-node";
  const file = path.join(home, "auth.json");
  fs.writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: secret }));
  const preview = async () => {
    await (h.cmds["credentials.native.preview"] as any)({ kind: "credentials.native.preview", requestId: "preview", label: "import-test" }, h.ctx);
    return h.replies.at(-1);
  };
  const confirm = async (previewId: string, sync: unknown) => {
    await (h.cmds["credentials.native.import"] as any)({ kind: "credentials.native.import", requestId: "confirm", previewId, agents: ["codex"], sync }, h.ctx);
    return h.replies.at(-1);
  };
  try {
    const initial = await preview();
    assert.equal(initial.items.find((i: any) => i.agent === "codex").status, "ready");
    assert.equal((await createCredentialVault(h.credsDir).listRecords()).length, 0);
    assert.equal((await confirm(initial.previewId, undefined)).type, "credentials.native.import.error");
    fs.writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: "changed" }));
    assert.equal((await confirm(initial.previewId, "node")).items[0].status, "changed");
    assert.equal((await confirm(initial.previewId, "node")).type, "credentials.native.import.error", "single use preview");
    fs.writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: secret }));
    const next = await preview();
    assert.equal((await confirm(next.previewId, "node")).items[0].status, "imported");
    const stored = await createCredentialVault(h.credsDir).readRecord("openai", "import-test");
    assert.equal(stored?.sync, "node");
    assert.equal(h.calls.pushed, 1);
    assert.equal((await preview()).items.find((i: any) => i.agent === "codex").status, "conflict");
    assert.ok(!JSON.stringify([h.replies, h.events, h.broadcasts]).includes(secret));
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    h.cleanup();
  }
});

test("account export includes OAuth material only after explicit recovery opt-in", async () => {
  const h = harness();
  try {
    await createCredentialVault(h.credsDir).modify("anthropic", async () => ({ type: "oauth", access: "access", refresh: "refresh-secret", expires: 123, refreshedAt: 100 }));
    await (h.cmds["credentials.account.export"] as any)({ kind: "credentials.account.export", requestId: "off" }, h.ctx);
    assert.equal(h.replies.at(-1)?.oauthEntries, undefined);
    await (h.cmds["credentials.account.export"] as any)({ kind: "credentials.account.export", requestId: "on", includeOAuth: true }, h.ctx);
    assert.equal(h.replies.at(-1)?.oauthEntries?.[0]?.refresh, "refresh-secret");
  } finally { h.cleanup(); }
});

test("credential.set persists a key, pushes auth, refreshes, and replies ok", async () => {
  const h = harness();
  try {
    await (h.cmds["credential.set"] as any)({ kind: "credential.set", provider: "openai", label: "default", key: "sk-test", requestId: "r1" }, h.ctx);
    assert.equal(h.calls.pushed, 1, "pushed model auth to control plane");
    assert.equal(h.calls.refreshed, 1, "refreshed the session after auth");
    assert.ok(h.replies.find((e) => e.type === "credential.set.ok" && e.requestId === "r1"), "replies ok");
    assert.ok(h.events.find((e) => e.type === "credentials.records"), "emits updated records");
    assert.ok(h.broadcasts.find((e) => e.type === "providers.list"), "broadcasts the provider list");

    // The write is real: it shows up in credentials.list.
    h.events.length = 0;
    await (h.cmds["credentials.list"] as any)({ kind: "credentials.list" }, h.ctx);
    const records = h.events.find((e) => e.type === "credentials.records")?.records ?? [];
    assert.ok(records.some((r: any) => r.provider === "openai"), "the set credential is listed");
  } finally { h.cleanup(); }
});

test("credential.set surfaces a failure as an error reply (no crash)", async () => {
  const h = harness({ pushModelAuthToControlPlane: async () => { throw new Error("cp down"); } });
  try {
    await (h.cmds["credential.set"] as any)({ kind: "credential.set", provider: "openai", label: "d", key: "sk", requestId: "r2" }, h.ctx);
    assert.match(h.replies.find((e) => e.type === "credential.set.error")?.error ?? "", /cp down/);
  } finally { h.cleanup(); }
});

test("presets.setActive emits presets and refreshes", async () => {
  const h = harness();
  try {
    await (h.cmds["credentials.presets.setActive"] as any)({ kind: "credentials.presets.setActive", active: "work" }, h.ctx);
    assert.equal(h.calls.refreshed, 1);
    assert.ok(h.events.find((e) => e.type === "credentials.presets"), "emits the presets");
  } finally { h.cleanup(); }
});
