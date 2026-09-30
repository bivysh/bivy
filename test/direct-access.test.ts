// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Direct access over Tailscale (`bivy tailscale`): the proxied listener never
// gets loopback trust, pairing codes are single-use and expire, and the CLI
// refuses to put Bivy on a Funnel'd (public) name or over someone else's serve.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { isAuthorized, markRemoteListener, resolveAuth } from "../src/auth.js";
import type { NodeIdentity } from "../src/identity.js";
import { PairCodes } from "../src/pair-codes.js";
import { parseTailscaleStatus, serveConflict, serveState } from "../bin/tailscale.mjs";
import { discoverTailnetMachines } from "../src/remote/tailnet.js";

const noToken = { verifyToken: () => null } as unknown as NodeIdentity;

/** Auth as seen by a server on 127.0.0.1 for a request from 127.0.0.1. */
async function authFor(remote: boolean, headers: Record<string, string> = {}) {
  let seen: ReturnType<typeof resolveAuth> | undefined;
  const server = http.createServer((req, res) => {
    seen = resolveAuth(noToken, req);
    res.end();
  });
  if (remote) markRemoteListener(server, { trustedLogin: () => "Owner@example.com" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await fetch(`http://127.0.0.1:${port}/api/status`, { headers });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return seen!;
}

async function run() {
  process.env.BIVY_REQUIRE_LOCAL_AUTH = "0"; // loopback bypass on, as on a single-user box

  const local = await authFor(false);
  assert.equal(isAuthorized(local), true, "the ordinary loopback listener still trusts local callers");
  const proxied = await authFor(true);
  assert.equal(proxied.loopback, false, "a tailscale-serve connection is not loopback");
  assert.equal(isAuthorized(proxied), false, "...so it needs a device token");

  // tailscale serve names the requester; the owner's own devices need no token.
  assert.equal(isAuthorized(await authFor(true, { "tailscale-user-login": "owner@example.com" })), true, "the owner's device is let in");
  assert.equal(isAuthorized(await authFor(true, { "tailscale-user-login": "guest@example.com" })), false, "someone else on the tailnet pairs first");
  process.env.BIVY_REQUIRE_LOCAL_AUTH = "1";
  assert.equal(isAuthorized(await authFor(true, { "tailscale-user-login": "owner@example.com" })), false, "not where other local accounts could forge the header");
  process.env.BIVY_REQUIRE_LOCAL_AUTH = "0";

  const status = (tags?: string[]) => JSON.stringify({ BackendState: "Running", Self: { DNSName: "box.tail1.ts.net.", UserID: 7, ...(tags ? { Tags: tags } : {}) }, User: { 7: { LoginName: "owner@example.com" } } });
  assert.equal(parseTailscaleStatus(status()).owner, "owner@example.com");
  assert.equal(parseTailscaleStatus(status(["tag:server"])).owner, null, "a tagged machine has no owner to trust");

  // Discovery asks online peers only, and lists those that answer as Bivy.
  const asked: string[] = [];
  const machines = await discoverTailnetMachines({
    status: async () => JSON.stringify({ Peer: {
      a: { DNSName: "desktop.tail1.ts.net.", HostName: "desktop", Online: true },
      b: { DNSName: "nas.tail1.ts.net.", HostName: "nas", Online: true },
      c: { DNSName: "laptop.tail1.ts.net.", HostName: "laptop", Online: false },
    } }),
    fetchImpl: (async (url: string) => {
      asked.push(url);
      const bivy = url.startsWith("https://desktop.");
      return new Response(JSON.stringify(bivy ? { bivy: true, name: "Desktop" } : { nope: true }), { status: bivy ? 200 : 404 });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(machines.map((m) => [m.name, m.url]), [["Desktop", "https://desktop.tail1.ts.net"]]);
  assert.equal(asked.some((u) => u.includes("laptop")), false, "offline peers aren't asked");

  let now = 1_000;
  const codes = new PairCodes(() => now);
  const { code } = codes.issue(60_000);
  assert.equal(codes.redeem(code), true, "a fresh code pairs once");
  assert.equal(codes.redeem(code), false, "...and never again");
  const late = codes.issue(60_000).code;
  now += 60_001;
  assert.equal(codes.redeem(late), false, "an expired code does not pair");

  const host = "box.tail1.ts.net";
  const ours = "http://127.0.0.1:4319";
  const serve = (handler: string, funnel = false) => JSON.stringify({
    Web: { [`${host}:443`]: { Handlers: { "/": { Proxy: handler } } } },
    ...(funnel ? { AllowFunnel: { [`${host}:443`]: true } } : {}),
  });
  assert.equal(serveConflict(serveState("{}", host), 4319), null, "an unused name is free");
  assert.equal(serveConflict(serveState(serve(ours), host), 4319), null, "re-running on our own serve is fine");
  assert.match(serveConflict(serveState(serve(ours, true), host), 4319) ?? "", /Funnel/, "a public (Funnel) name is refused");
  assert.match(serveConflict(serveState(serve("http://127.0.0.1:3000"), host), 4319) ?? "", /already sends/, "another app's serve is not replaced");

  console.log("direct-access: all tests passed");
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
