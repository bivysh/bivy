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

console.log("ephemeral-exec: all tests passed");
