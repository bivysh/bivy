import assert from "node:assert/strict";
import test from "node:test";
import { DeploymentExtension } from "../src/deployment-extension.js";

test("deployment extension defaults to unrestricted with no service", async () => {
  const extension = new DeploymentExtension(undefined, undefined, async () => { throw new Error("must not fetch"); });
  assert.deepEqual(await extension.authorize("account", "automation.run", "run"), { allowed: true });
  assert.deepEqual([...await extension.filterSessions("account", ["s1", "s2"])], ["s1", "s2"]);
  await extension.record("account", { type: "ephemeral.first-agent-event", attemptId: "a1", at: new Date(0).toISOString() });
  assert.equal(await extension.account("account"), undefined);
});

test("configured policy forwards opaque operations and fails closed", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const extension = new DeploymentExtension("https://policy.example", "secret", async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ allowed: false, code: "quota_exhausted" }), { status: 429, headers: { "content-type": "application/json" } });
  });
  assert.deepEqual(await extension.authorize("a", "automation.run", "r1", { computeSource: "managed", sizeId: "large", memoryMiB: 16384 }), { allowed: false, code: "quota_exhausted" });
  assert.equal(requests[0]?.url, "https://policy.example/v1/policy/check");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    subject: { accountId: "a" }, operation: "automation.run", idempotencyKey: "r1",
    context: { computeSource: "managed", sizeId: "large", memoryMiB: 16384 },
  });
  assert.equal(requests[0]?.init?.headers && (requests[0].init.headers as Record<string, string>).authorization, "Bearer secret");
});

test("lifecycle events use the authenticated neutral extension contract", async () => {
  let request: { url: string; body: unknown } | undefined;
  const extension = new DeploymentExtension("https://policy.example", "secret", async (url, init) => {
    request = { url: String(url), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const event = { type: "ephemeral.settled" as const, attemptId: "a1", at: new Date(0).toISOString(), machineSeconds: 12, activeAgentSeconds: 5 };
  await extension.record("a", event);
  assert.deepEqual(request, { url: "https://policy.example/v1/events", body: { subject: { accountId: "a" }, event } });
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
