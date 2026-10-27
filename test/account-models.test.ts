// SPDX-License-Identifier: MIT
// A ChatGPT plan lists the models it includes; Pi's fixed catalog is filtered to
// that list, and a failed lookup leaves the catalog alone.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCredentialVault } from "../src/credentials/store.js";
import { accountModelIds, resetAccountModels, withinAccount } from "../src/runtime/account-models.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-account-models-"));
const credsDir = path.join(dir, "credentials");
const realFetch = globalThis.fetch;
try {
  await createCredentialVault(credsDir).modifyRecord("openai-codex", "default", async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000, accountId: "acct" }));
  let calls = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls++;
    assert.match(String(url), /backend-api\/codex\/models/);
    assert.equal((init.headers as Record<string, string>)["chatgpt-account-id"], "acct");
    return new Response(JSON.stringify({ models: [
      { slug: "gpt-5.6-terra", visibility: "list" },
      { slug: "gpt-5.6-luna", visibility: "list" },
      { slug: "gpt-reserve", visibility: "hide" },
    ] }));
  }) as typeof fetch;

  const ids = await accountModelIds(credsDir, "openai-codex");
  assert.deepEqual([...ids!].sort(), ["gpt-5.6-luna", "gpt-5.6-terra"], "only listed models count");
  await accountModelIds(credsDir, "openai-codex");
  assert.equal(calls, 1, "the list is cached");

  const catalog = [
    { provider: "openai-codex", id: "gpt-6.1-sol" },
    { provider: "openai-codex", id: "gpt-5.6-terra" },
    { provider: "anthropic", id: "claude-opus-4-8" },
  ];
  assert.deepEqual(withinAccount(catalog, new Map([["openai-codex", ids!]])).map((m) => m.id), ["gpt-5.6-terra", "claude-opus-4-8"], "other providers pass through");

  resetAccountModels();
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  assert.equal(await accountModelIds(credsDir, "openai-codex"), undefined, "a failed lookup filters nothing");
  assert.equal(await accountModelIds(credsDir, "anthropic"), undefined, "providers without a source filter nothing");
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("account-models: all tests passed");
