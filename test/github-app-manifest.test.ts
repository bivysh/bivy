import assert from "node:assert/strict";
import { buildAppManifest, convertManifest, renderManifestForm } from "../src/github-app-manifest.js";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

await check("buildAppManifest: requests the queue's permissions + events, points the webhook", () => {
  const m = buildAppManifest({
    name: "Bivy laptop",
    url: "https://bivy.sh",
    hookUrl: "https://cp.example/webhooks/github/hook_1",
    redirectUrl: "http://localhost:4317/github/app/manifest/callback",
  }) as any;
  assert.equal(m.hook_attributes.url, "https://cp.example/webhooks/github/hook_1");
  assert.equal(m.redirect_url, "http://localhost:4317/github/app/manifest/callback");
  assert.equal(m.public, false);
  assert.deepEqual(m.default_events, ["issues", "issue_comment"]);
  assert.equal(m.default_permissions.issues, "write");
  assert.equal(m.default_permissions.contents, "write");
  assert.equal(m.default_permissions.pull_requests, "write");
});

await check("renderManifestForm: auto-submits the manifest to GitHub with state", () => {
  const html = renderManifestForm({ name: "x" }, { state: "hook_9" });
  assert.match(html, /action="https:\/\/github\.com\/settings\/apps\/new\?state=hook_9"/);
  assert.match(html, /name="manifest"/);
  assert.match(html, /\.submit\(\)/);
  // Org variant targets the org endpoint.
  const org = renderManifestForm({ name: "x" }, { state: "s", org: "acme" });
  assert.match(org, /organizations\/acme\/settings\/apps\/new/);
});

await check("convertManifest: exchanges the code for id/pem/webhook_secret", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method} ${url}`);
    return {
      ok: true,
      status: 201,
      json: async () => ({ id: 42, slug: "bivy-laptop", pem: "-----KEY-----", webhook_secret: "whsec", html_url: "https://github.com/apps/bivy-laptop" }),
      text: async () => "",
    } as Response;
  }) as typeof fetch;
  const app = await convertManifest("code123", fetchImpl);
  assert.equal(app.appId, "42");
  assert.equal(app.pem, "-----KEY-----");
  assert.equal(app.webhookSecret, "whsec");
  assert.equal(app.htmlUrl, "https://github.com/apps/bivy-laptop");
  assert.equal(calls[0], "POST https://api.github.com/app-manifests/code123/conversions");
});

await check("convertManifest: throws on error and on a missing key", async () => {
  const err = (async () => ({ ok: false, status: 422, text: async () => "bad", json: async () => ({}) }) as Response) as typeof fetch;
  await assert.rejects(() => convertManifest("c", err), /422/);
  const missing = (async () => ({ ok: true, status: 201, json: async () => ({ id: 1 }), text: async () => "" }) as Response) as typeof fetch;
  await assert.rejects(() => convertManifest("c", missing), /missing/);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\ngithub-app-manifest: all tests passed");
