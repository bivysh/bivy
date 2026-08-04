import assert from "node:assert/strict";
import http from "node:http";
import { EgressProxy, parseHostPort, allowAllDecider, denyAllDecider, allowlistDecider, type NetEvent } from "../src/harness/net-proxy.js";
import { startSessionEgress, sessionEgressEnv, stopSessionEgress, applySessionSandboxEgress } from "../src/harness/egress.js";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).stack ?? (error as Error).message}`);
  }
}

function listen(server: http.Server): Promise<number> {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as any).port)));
}

/** Make a plain-HTTP request through the proxy to an absolute URL. */
function viaProxy(proxyPort: number, targetUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const req = http.request(
      { host: "127.0.0.1", port: proxyPort, method: "GET", path: targetUrl, headers: { host: u.host } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  await check("parseHostPort handles host:port, bare host, and IPv6", () => {
    assert.deepEqual(parseHostPort("example.com:443", 443), { host: "example.com", port: 443 });
    assert.deepEqual(parseHostPort("example.com", 443), { host: "example.com", port: 443 });
    assert.deepEqual(parseHostPort("[::1]:8443", 443), { host: "::1", port: 8443 });
    return Promise.resolve();
  });

  await check("allowed plain-HTTP request is forwarded and logged", async () => {
    const origin = http.createServer((_req, res) => res.end("HELLO_ORIGIN"));
    const originPort = await listen(origin);
    const events: NetEvent[] = [];
    const proxy = await EgressProxy.start({ onEvent: (e) => events.push(e) });

    const out = await viaProxy(proxy.port, `http://127.0.0.1:${originPort}/x`);
    assert.equal(out.status, 200);
    assert.equal(out.body, "HELLO_ORIGIN");
    const ev = events.find((e) => e.type === "http");
    assert.ok(ev && ev.type === "http");
    assert.equal((ev as any).host, "127.0.0.1");
    assert.equal((ev as any).allowed, true);

    await proxy.stop();
    origin.close();
  });

  await check("denied host is blocked with 403 and never reaches the origin", async () => {
    let hits = 0;
    const origin = http.createServer((_req, res) => { hits++; res.end("SHOULD_NOT_HAPPEN"); });
    const originPort = await listen(origin);
    const proxy = await EgressProxy.start({
      decide: (host) => ({ allow: host !== "127.0.0.1", reason: "blocked host" }),
    });

    const out = await viaProxy(proxy.port, `http://127.0.0.1:${originPort}/x`);
    assert.equal(out.status, 403);
    assert.match(out.body, /blocked host/);
    assert.equal(hits, 0, "origin must not be contacted for a denied host");

    await proxy.stop();
    origin.close();
  });

  await check("env() advertises the proxy and excludes localhost", async () => {
    const proxy = await EgressProxy.start();
    const env = proxy.env();
    assert.equal(env.HTTP_PROXY, `http://127.0.0.1:${proxy.port}`);
    assert.equal(env.HTTPS_PROXY, env.HTTP_PROXY);
    assert.match(env.NO_PROXY, /127\.0\.0\.1/);
    await proxy.stop();
  });

  await check("composable deciders: allowAll / denyAll / allowlist", async () => {
    assert.deepEqual(await allowAllDecider("anything.com", 443), { allow: true });
    const deny = denyAllDecider("nope");
    assert.deepEqual(await deny("x.com", 80), { allow: false, reason: "nope" });
    const allow = allowlistDecider(["github.com", "Api.Example.com"]);
    assert.equal((await allow("github.com", 443)).allow, true);        // exact
    assert.equal((await allow("codeload.github.com", 443)).allow, true); // subdomain of apex
    assert.equal((await allow("api.example.com", 443)).allow, true);     // case-insensitive
    assert.equal((await allow("evil.com", 443)).allow, false);           // not listed
    assert.equal((await allow("notgithub.com", 443)).allow, false);      // suffix without dot boundary
    assert.equal((await allowlistDecider([])("anything.com", 443)).allow, false); // empty = deny all
  });

  await check("per-session egress: a deny-all session proxy blocks, then clears on stop", async () => {
    let hits = 0;
    const origin = http.createServer((_req, res) => { hits++; res.end("NOPE"); });
    const originPort = await listen(origin);
    const sid = "sess-egress-test";
    await startSessionEgress(sid, denyAllDecider("read-only"));
    const env = sessionEgressEnv(sid);
    assert.ok(env?.HTTP_PROXY, "session should advertise its own proxy env");
    const port = Number(new URL(env!.HTTP_PROXY).port);
    const out = await viaProxy(port, `http://127.0.0.1:${originPort}/x`);
    assert.equal(out.status, 403);
    assert.equal(hits, 0, "denied session traffic must not reach the origin");
    await stopSessionEgress(sid);
    assert.equal(sessionEgressEnv(sid), undefined, "stop clears the per-session proxy");
    origin.close();
  });

  await check("applySessionSandboxEgress: opt-in gate + read-only only", async () => {
    const prev = process.env.BIVY_SANDBOX_NET;
    try {
      delete process.env.BIVY_SANDBOX_NET;
      await applySessionSandboxEgress("s-off", "read-only");
      assert.equal(sessionEgressEnv("s-off"), undefined, "no enforcement unless opted in");

      process.env.BIVY_SANDBOX_NET = "1";
      await applySessionSandboxEgress("s-ww", "workspace-write");
      assert.equal(sessionEgressEnv("s-ww"), undefined, "network-allowing tiers get no proxy");
      await applySessionSandboxEgress("s-ro", "read-only");
      assert.ok(sessionEgressEnv("s-ro")?.HTTP_PROXY, "read-only gets a per-session deny proxy when opted in");
    } finally {
      await stopSessionEgress("s-off");
      await stopSessionEgress("s-ww");
      await stopSessionEgress("s-ro");
      if (prev === undefined) delete process.env.BIVY_SANDBOX_NET;
      else process.env.BIVY_SANDBOX_NET = prev;
    }
  });

  if (failures > 0) {
    console.error(`\n${failures} net-proxy test(s) failed`);
    process.exit(1);
  }
  console.log("\nall net-proxy tests passed");
}

void main();
