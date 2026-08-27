// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { getAppInstallation, listAppInstallations, listInstallationRepositories } from "../src/hosted-github-auth.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

await test("validates the App key and returns installable owners", async () => {
  const calls: Array<{ url: string; authorization: string }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), authorization: String((init?.headers as Record<string, string>)?.authorization) });
    return new Response(JSON.stringify([{ id: 42, account: { id: 9001, login: "acme", type: "Organization" } }]), { status: 200 });
  }) as typeof fetch;
  const installations = await listAppInstallations("123", pem, fakeFetch, 1_700_000_000);
  assert.deepEqual(installations, [{ id: "42", account: "acme", accountId: "9001", accountType: "Organization" }]);
  assert.match(calls[0]!.url, /\/app\/installations/);
  assert.match(calls[0]!.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
});

await test("installation lookup returns the immutable GitHub target id for installer verification", async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({
    id: 42, account: { id: 9001, login: "acme", type: "Organization" }, repository_selection: "selected",
  }), { status: 200 })) as typeof fetch;
  assert.deepEqual(await getAppInstallation("123", pem, "42", fakeFetch, 1_700_000_000), {
    id: "42", account: "acme", accountId: "9001", accountType: "Organization", repositorySelection: "selected",
  });
});

await test("mints an installation token and maps repositories for the browser", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (String(url).includes("access_tokens")) {
      return new Response(JSON.stringify({ token: "short-lived", expires_at: "soon" }), { status: 201 });
    }
    return new Response(JSON.stringify({ repositories: [{
      full_name: "acme/rocket",
      description: "Launch it",
      private: true,
      default_branch: "trunk",
    }] }), { status: 200 });
  }) as typeof fetch;
  const repos = await listInstallationRepositories({ appId: "123", installationId: "42", privateKeyPem: pem }, fakeFetch);
  assert.deepEqual(repos, [{ slug: "acme/rocket", description: "Launch it", private: true, defaultBranch: "trunk" }]);
  assert.match(calls[0]!, /installations\/42\/access_tokens/);
  assert.match(calls[1]!, /installation\/repositories/);
});

await test("does not hide GitHub validation errors", async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })) as typeof fetch;
  await assert.rejects(() => listAppInstallations("123", pem, fakeFetch), /Bad credentials/);
});

console.log(`hosted-github-auth: ${passed} test(s) passed`);
