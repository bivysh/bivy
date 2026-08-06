import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import {
  createAppJwt,
  mintInstallationToken,
  resolveInstallationId,
  InstallationTokenCache,
} from "../src/github-app-auth.js";

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

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const decodeSeg = (seg: string) => JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));

/** A fetch stub that records the call and returns a fixed JSON body. */
function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; authorization?: string; method?: string }> = [];
  const fetchImpl = (async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ url, authorization: init?.headers?.authorization, method: init?.method });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

await check("createAppJwt: RS256 JWT with correct claims, verifiable by the public key", () => {
  const now = 1_700_000_000;
  const jwt = createAppJwt("12345", privatePem, now);
  const [h, p, s] = jwt.split(".");
  const header = decodeSeg(h);
  const payload = decodeSeg(p);
  assert.equal(header.alg, "RS256");
  assert.equal(payload.iss, "12345");
  assert.equal(payload.iat, now - 30); // backdated for clock skew
  assert.ok(payload.exp - payload.iat <= 600); // under GitHub's 10-minute ceiling
  // The signature verifies against the app public key over "<h>.<p>".
  const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicPem, Buffer.from(s, "base64url"));
  assert.equal(ok, true);
  // Tampering with the payload breaks verification.
  const bad = createVerify("RSA-SHA256").update(`${h}.${p}x`).verify(publicPem, Buffer.from(s, "base64url"));
  assert.equal(bad, false);
});

await check("mintInstallationToken: posts a Bearer JWT to the installation endpoint", async () => {
  const s = stubFetch(201, { token: "ghs_abc", expires_at: "2026-07-13T13:00:00Z" });
  const res = await mintInstallationToken({
    appId: "12345",
    privateKeyPem: privatePem,
    installationId: 42,
    nowSec: 1_700_000_000,
    fetchImpl: s.fetchImpl,
  });
  assert.equal(res.token, "ghs_abc");
  assert.equal(res.expiresAt, "2026-07-13T13:00:00Z");
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, "https://api.github.com/app/installations/42/access_tokens");
  assert.match(s.calls[0].authorization ?? "", /^Bearer /);
});

await check("mintInstallationToken: throws on a non-2xx response", async () => {
  const s = stubFetch(404, { message: "Not Found" });
  await assert.rejects(
    () => mintInstallationToken({ appId: "1", privateKeyPem: privatePem, installationId: 9, fetchImpl: s.fetchImpl }),
    /404/,
  );
});

await check("resolveInstallationId: returns the id for an installed repo (app-JWT authed)", async () => {
  const s = stubFetch(200, { id: 987654 });
  const id = await resolveInstallationId({
    appId: "12345",
    privateKeyPem: privatePem,
    owner: "bivysh",
    repo: "bivy",
    nowSec: 1_700_000_000,
    fetchImpl: s.fetchImpl,
  });
  assert.equal(id, "987654");
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, "https://api.github.com/repos/bivysh/bivy/installation");
  assert.match(s.calls[0].authorization ?? "", /^Bearer /);
});

await check("resolveInstallationId: returns undefined when the app isn't installed (404)", async () => {
  const s = stubFetch(404, { message: "Not Found" });
  const id = await resolveInstallationId({ appId: "1", privateKeyPem: privatePem, owner: "x", repo: "y", fetchImpl: s.fetchImpl });
  assert.equal(id, undefined);
});

await check("resolveInstallationId: rejects path-like owner and repo input before fetching", async () => {
  const s = stubFetch(200, { id: 1 });
  assert.equal(await resolveInstallationId({ appId: "1", privateKeyPem: privatePem, owner: "safe/../evil", repo: "repo", fetchImpl: s.fetchImpl }), undefined);
  assert.equal(await resolveInstallationId({ appId: "1", privateKeyPem: privatePem, owner: "safe", repo: "repo?x=/evil", fetchImpl: s.fetchImpl }), undefined);
  assert.equal(s.calls.length, 0);
});

await check("InstallationTokenCache: mints once, reuses within TTL, re-mints near expiry", async () => {
  let issued = 0;
  const fetchImpl = (async () => {
    issued += 1;
    // Token valid for 1h from a fixed base; expiry independent of clock so the
    // test controls staleness via the injected now().
    return {
      ok: true,
      status: 201,
      json: async () => ({ token: `t${issued}`, expires_at: "2026-07-13T13:00:00Z" }),
      text: async () => "",
    } as Response;
  }) as typeof fetch;

  const base = Date.parse("2026-07-13T12:00:00Z"); // 1h before expiry
  let nowMs = base;
  const cache = new InstallationTokenCache("1", privatePem, fetchImpl, () => nowMs);

  assert.equal(await cache.get(7), "t1"); // first call mints
  assert.equal(await cache.get(7), "t1"); // still fresh → cached, no new mint
  assert.equal(issued, 1);

  // A different installation mints its own token.
  assert.equal(await cache.get(8), "t2");
  assert.equal(issued, 2);

  // Advance to within the 5-minute skew window of expiry → re-mint.
  nowMs = Date.parse("2026-07-13T12:57:00Z");
  assert.equal(await cache.get(7), "t3");
  assert.equal(issued, 3);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\ngithub-app-auth: all tests passed");
