import assert from "node:assert/strict";
import { buildHttpDecider } from "../src/harness/mcp-proxy-cli.js";

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

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

function fakeFetch(response: { ok: boolean; body?: unknown; throws?: boolean }, seen: { url?: string; body?: any }): FetchLike {
  return async (url, init) => {
    seen.url = url;
    seen.body = JSON.parse(init.body);
    if (response.throws) throw new Error("network down");
    return { ok: response.ok, json: async () => response.body };
  };
}

async function main() {
  await check("allow decision from daemon passes through", async () => {
    const seen: any = {};
    const decide = buildHttpDecider("http://x", "sess-1", "fs", fakeFetch({ ok: true, body: { allow: true } }, seen));
    const d = await decide("read_file", { path: "/w" });
    assert.equal(d.allow, true);
    assert.equal(seen.url, "http://x/api/mcp/decide");
    assert.deepEqual(seen.body, { sessionId: "sess-1", server: "fs", tool: "read_file", args: { path: "/w" } });
  });

  await check("deny decision from daemon carries the reason", async () => {
    const seen: any = {};
    const decide = buildHttpDecider("http://x", "s", "fs", fakeFetch({ ok: true, body: { allow: false, reason: "blocked by rule" } }, seen));
    const d = await decide("rm", {});
    assert.equal(d.allow, false);
    assert.equal(d.reason, "blocked by rule");
  });

  await check("non-ok HTTP response fails open (allow)", async () => {
    const decide = buildHttpDecider("http://x", "s", "fs", fakeFetch({ ok: false }, {} as any));
    assert.equal((await decide("x", {})).allow, true);
  });

  await check("transport error fails open (allow) — never wedge the agent", async () => {
    const decide = buildHttpDecider("http://x", "s", "fs", fakeFetch({ ok: true, throws: true }, {} as any));
    assert.equal((await decide("x", {})).allow, true);
  });

  await check("missing allow field defaults to allow (only explicit false denies)", async () => {
    const decide = buildHttpDecider("http://x", "s", "fs", fakeFetch({ ok: true, body: {} }, {} as any));
    assert.equal((await decide("x", {})).allow, true);
  });

  if (failures > 0) {
    console.error(`\n${failures} mcp-cli test(s) failed`);
    process.exit(1);
  }
  console.log("\nall mcp-cli tests passed");
}

void main();
