import assert from "node:assert/strict";
import { execEphemeralRequest, EPHEMERAL_ALLOWED_HOSTS } from "../src/ephemeral-exec.js";

// SSRF guard: only provider hosts may be proxied.
await assert.rejects(
  () => execEphemeralRequest({ url: "https://evil.example/steal", method: "POST", headers: { authorization: "Bearer secret" } }),
  /non-provider host/,
  "must refuse a non-provider host",
);
await assert.rejects(() => execEphemeralRequest({ url: "not a url" }), /Bad provider URL/);
assert.ok(EPHEMERAL_ALLOWED_HOSTS.has("api.hetzner.cloud"));
assert.ok(EPHEMERAL_ALLOWED_HOSTS.has("api.machines.dev"));
assert.ok(EPHEMERAL_ALLOWED_HOSTS.has("api.sprites.dev"));
assert.ok(EPHEMERAL_ALLOWED_HOSTS.has("ec2.us-east-1.amazonaws.com"));
assert.ok(EPHEMERAL_ALLOWED_HOSTS.has("ssm.us-east-1.amazonaws.com"));

// Allowed AWS host: SigV4-signed requests (headers built by the caller) are
// forwarded verbatim, same as any other provider.
{
  let seenAws: any = null;
  const fakeFetch = (async (url: any, init: any) => {
    seenAws = { url, init };
    return { status: 200, text: async () => JSON.stringify({ Parameter: { Value: "ami-0abcdef1234567890" } }) } as any;
  }) as unknown as typeof fetch;
  const res = await execEphemeralRequest(
    {
      url: "https://ssm.us-east-1.amazonaws.com/",
      method: "POST",
      headers: { authorization: "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/...", "x-amz-target": "AmazonSSM.GetParameter" },
      body: { Name: "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id" },
    },
    fakeFetch,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { Parameter: { Value: "ami-0abcdef1234567890" } });
  assert.equal(seenAws.init.headers["x-amz-target"], "AmazonSSM.GetParameter");
}

// Allowed host: forwards method/headers/body and parses the JSON response.
let seen: any = null;
const fakeFetch = (async (url: any, init: any) => {
  seen = { url, init };
  return { status: 201, text: async () => JSON.stringify({ server: { id: 7 } }) } as any;
}) as unknown as typeof fetch;

const res = await execEphemeralRequest(
  { url: "https://api.hetzner.cloud/v1/servers", method: "POST", headers: { authorization: "Bearer hz" }, body: { name: "x" } },
  fakeFetch,
);
assert.equal(res.status, 201);
assert.deepEqual(res.body, { server: { id: 7 } });
assert.equal(seen.init.method, "POST");
assert.equal(seen.init.headers.authorization, "Bearer hz");
assert.equal(seen.init.headers["content-type"], "application/json");
assert.equal(seen.init.body, JSON.stringify({ name: "x" }));

// GET requests carry no body and don't force a content-type.
seen = null;
await execEphemeralRequest({ url: "https://api.machines.dev/v1/apps/x/machines/1", headers: { authorization: "Bearer f" } }, fakeFetch);
assert.equal(seen.init.method, "GET");
assert.equal(seen.init.body, undefined);

// Every request is issued with `redirect: "manual"` — auto-follow is disabled
// so we get a chance to re-validate each hop ourselves.
seen = null;
await execEphemeralRequest({ url: "https://api.hetzner.cloud/v1/servers", headers: { authorization: "Bearer hz" } }, fakeFetch);
assert.equal(seen.init.redirect, "manual");

function redirectResponse(status: number, location: string | null, body = "") {
  return { status, headers: { get: (h: string) => (h.toLowerCase() === "location" ? location : null) }, text: async () => body } as any;
}

// Redirects: the allowlist check must be re-applied on EVERY hop, not just the
// initial URL — a plain `fetch` would otherwise follow a 3xx to any host,
// carrying the Authorization header with it (the SSRF hole this closes).
{
  const evilRedirectFetch = (async (url: any) => {
    if (url === "https://api.hetzner.cloud/v1/servers") return redirectResponse(302, "https://evil.example/steal");
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => execEphemeralRequest({ url: "https://api.hetzner.cloud/v1/servers", headers: { authorization: "Bearer hz" } }, evilRedirectFetch),
    /non-provider host/,
    "a redirect to a non-provider host must be refused, not silently followed",
  );
}

// A redirect to another ALLOWED host is followed (re-validated), and the final
// response is returned. A 307 preserves the original method and body.
{
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const hopFetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    if (url === "https://api.fly.io/v1/apps/x/machines") return redirectResponse(307, "https://api.machines.dev/v1/apps/x/machines");
    if (url === "https://api.machines.dev/v1/apps/x/machines") return redirectResponse(200, null, JSON.stringify({ ok: true }));
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
  const res = await execEphemeralRequest(
    { url: "https://api.fly.io/v1/apps/x/machines", method: "POST", body: { name: "x" }, headers: { authorization: "Bearer f" } },
    hopFetch,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(
    calls.map((c) => c.url),
    ["https://api.fly.io/v1/apps/x/machines", "https://api.machines.dev/v1/apps/x/machines"],
    "the redirect target was actually requested",
  );
  assert.equal(calls[1]?.method, "POST", "307 preserves the original method");
  assert.equal(calls[1]?.body, JSON.stringify({ name: "x" }), "307 preserves the original body");
}

// A 302 redirect of a POST downgrades to a bodyless GET, mirroring the fetch
// spec's own auto-follow behavior (which this manual loop replicates).
{
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const hopFetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    if (url === "https://api.hetzner.cloud/v1/servers") return redirectResponse(302, "https://api.hetzner.cloud/v1/servers/moved");
    return redirectResponse(200, null, JSON.stringify({ ok: true }));
  }) as unknown as typeof fetch;
  await execEphemeralRequest({ url: "https://api.hetzner.cloud/v1/servers", method: "POST", body: { name: "x" }, headers: { authorization: "Bearer hz" } }, hopFetch);
  assert.equal(calls[1]?.method, "GET", "302 downgrades a non-GET method to GET");
  assert.equal(calls[1]?.body, undefined, "302 drops the body when downgrading to GET");
}

// A redirect with no Location header is an error, not a silent success.
await assert.rejects(
  () => execEphemeralRequest({ url: "https://api.hetzner.cloud/v1/servers" }, (async () => redirectResponse(302, null)) as unknown as typeof fetch),
  /Location header/,
);

// A redirect loop is bounded — it throws instead of hanging forever.
{
  let calls = 0;
  const loopFetch = (async () => {
    calls++;
    return redirectResponse(302, "https://api.hetzner.cloud/v1/servers");
  }) as unknown as typeof fetch;
  await assert.rejects(() => execEphemeralRequest({ url: "https://api.hetzner.cloud/v1/servers" }, loopFetch), /Too many redirects/);
  assert.ok(calls < 20, `redirect loop must be bounded, got ${calls} calls`);
}

console.log("ephemeral-exec: all tests passed");
