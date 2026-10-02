// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { opencodeAuthEnv } from "../src/runtime/opencode-auth.js";

function scratch(vault: Record<string, unknown>, native?: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-auth-"));
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(vault));
  const authPath = path.join(dir, "opencode-auth.json");
  if (native) fs.writeFileSync(authPath, JSON.stringify(native));
  return { credsDir: dir, authPath };
}

const chatgpt = { type: "oauth", access: "chatgpt-access", refresh: "chatgpt-refresh", expires: Date.now() + 3_600_000 };

test("a ChatGPT plan connected in Bivy reaches OpenCode next to the user's own logins, without its refresh token", async () => {
  const { credsDir, authPath } = scratch({ "openai-codex": chatgpt }, { opencode: { type: "api", key: "zen" } });
  const env = await opencodeAuthEnv(credsDir, authPath);
  const auth = JSON.parse(env.OPENCODE_AUTH_CONTENT!);
  assert.deepEqual(auth.opencode, { type: "api", key: "zen" }, "the user's own login is kept");
  assert.equal(auth.openai.access, "chatgpt-access");
  assert.equal(auth.openai.refresh, "", "OpenCode never rotates the vault's refresh token");
  assert.deepEqual(JSON.parse(fs.readFileSync(authPath, "utf8")), { opencode: { type: "api", key: "zen" } }, "the user's file is not written");
});

test("the user's own OpenCode login for a provider wins, and no subscription means no projection", async () => {
  const own = scratch({ "openai-codex": chatgpt }, { openai: { type: "oauth", access: "theirs", refresh: "r", expires: 1 } });
  assert.deepEqual(await opencodeAuthEnv(own.credsDir, own.authPath), {});
  const none = scratch({});
  assert.deepEqual(await opencodeAuthEnv(none.credsDir, none.authPath), {});
});
