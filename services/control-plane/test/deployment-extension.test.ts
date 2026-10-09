import assert from "node:assert/strict";
import test from "node:test";
import { DeploymentExtension } from "../src/deployment-extension.js";

test("deployment extension defaults to unrestricted with no service", async () => {
  const extension = new DeploymentExtension(undefined, undefined, async () => { throw new Error("must not fetch"); });
  assert.deepEqual(await extension.authorize("account", "automation.run", "run"), { allowed: true });
  assert.deepEqual([...await extension.filterSessions("account", ["s1", "s2"])], ["s1", "s2"]);
  assert.equal(await extension.account("account"), undefined);
});

test("configured policy forwards opaque operations and fails closed", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const extension = new DeploymentExtension("https://policy.example", "secret", async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({
      allowed: false,
      code: "quota_exhausted",
      actions: [{ id: "upgrade", label: "Upgrade", kind: "primary" }],
    }), { status: 429, headers: { "content-type": "application/json" } });
  });
  assert.deepEqual(await extension.authorize("a", "automation.run", "r1"), {
    allowed: false,
    code: "quota_exhausted",
    actions: [{ id: "upgrade", label: "Upgrade", kind: "primary" }],
  });
  assert.deepEqual(await extension.authorize("a", "automation.run", "r1", { source: "github:issue" }), { allowed: false, code: "quota_exhausted", actions: [{ id: "upgrade", label: "Upgrade", kind: "primary" }] });
  assert.equal(JSON.parse(String(requests[1]?.init?.body)).context.source, "github", "policy sees the source kind, not its identifiers");
  // A delegated run's source carries parent ids and exceeds bounded extension fields.
  await extension.authorize("a", "automation.run", "r2", { source: `agent-delegation:v1:1:${"x".repeat(48)}:${"y".repeat(56)}` });
  assert.equal(JSON.parse(String(requests[2]?.init?.body)).context.source, "agent-delegation");
  assert.equal(requests[0]?.url, "https://policy.example/v1/policy/check");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    subject: { accountId: "a" }, operation: "automation.run", idempotencyKey: "r1",
    context: {},
  });
  assert.equal(requests[0]?.init?.headers && (requests[0].init.headers as Record<string, string>).authorization, "Bearer secret");
});

test("account events use the authenticated neutral extension contract", async () => {
  let request: { url: string; body: unknown } | undefined;
  const extension = new DeploymentExtension("https://policy.example", "secret", async (url, init) => {
    request = { url: String(url), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const signIn = { type: "account.signed-in" as const, at: new Date(1).toISOString(), accountCreatedAt: new Date(0).toISOString() };
  await extension.recordAccount("a", "a@example.com", signIn);
  assert.deepEqual(request, { url: "https://policy.example/v1/events", body: { subject: { accountId: "a", email: "a@example.com" }, event: signIn } });
});

test("published app IDs are forwarded only when there are any", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const extension = new DeploymentExtension("https://policy.example", "secret", async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await extension.publishApps("a", []);
  await extension.publishApps("a", ["app1"]);
  assert.deepEqual(requests, [{ url: "https://policy.example/v1/apps/publish", body: { subject: { accountId: "a" }, appIds: ["app1"] } }]);
});

test("account presentation remains opaque to Core", async () => {
  const extension = new DeploymentExtension("https://policy.example", "secret", async () => new Response(JSON.stringify({
    presentation: { title: "Managed account", facts: [{ id: "tier", label: "Tier", value: "Example" }], actions: [] },
    privateData: { ignored: true },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  assert.deepEqual(await extension.account("a"), {
    title: "Managed account", facts: [{ id: "tier", label: "Tier", value: "Example" }], actions: [],
  });
});

test("configured extension rejects malformed decisions instead of allowing", async () => {
  const extension = new DeploymentExtension("https://policy.example", "secret", async () => new Response("{}", { status: 200 }));
  await assert.rejects(() => extension.authorize("a", "relay.connect"), /invalid policy decision/);
});

test("configuration requires URL and token together", () => {
  assert.throws(() => new DeploymentExtension("https://policy.example", undefined), /configured together/);
});

test("deployment compute is absent without a service and asks the configured one", async () => {
  assert.equal(new DeploymentExtension(undefined, undefined, async () => { throw new Error("must not fetch"); }).computeSource(), undefined);
  const requests: Array<{ url: string; body: unknown }> = [];
  const replies: Record<string, unknown> = {
    "https://policy.example/v1/compute/profile": { profile: { provider: "fly", accountMachine: true } },
  };
  const source = new DeploymentExtension("https://policy.example", "secret", async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(replies[String(url)]), { headers: { "content-type": "application/json" } });
  }).computeSource()!;
  assert.deepEqual(await source.profile("interactive", "a", "claude"), { provider: "fly", accountMachine: true });
  assert.deepEqual(requests.map((request) => request.body), [
    { subject: { accountId: "a" }, purpose: "interactive", runtimeId: "claude" },
  ]);
});
