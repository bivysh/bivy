import assert from "node:assert/strict";
import { ControlPlaneTaskPoller, type WorkItem, type EvidencePatch } from "../src/control-plane-tasks.js";
import type { RunDecision, RunFailureContext, RunPolicy } from "../src/policy/run-policy.js";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

const cfg = { controlPlaneUrl: "http://cp.test", enrollmentToken: "t", labels: ["bivy"], pollMs: 60_000 };
const baseItem: WorkItem = { id: "run1", label: "bivy", source: "github:issue", status: "pending", title: "Do a thing" };

/** Install a fetch stub that records the path of every call and always succeeds.
 *  Returns the recorder + a restore fn. Evidence bodies are captured too. */
function stubFetch() {
  const calls: string[] = [];
  const evidence: EvidencePatch[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    const path = url.replace(cfg.controlPlaneUrl, "");
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/evidence") && init?.body) evidence.push(JSON.parse(init.body) as EvidencePatch);
    return { ok: true, status: 200, json: async () => ({ ok: true, item: baseItem }) } as Response;
  }) as typeof fetch;
  return { calls, evidence, restore: () => void (globalThis.fetch = original) };
}

const paths = (calls: string[]) => calls.map((c) => c.split(" ")[1]!.replace("/node/work/run1", ""));
const noSleep = { sleep: async () => {} };

// A scripted policy so decisions don't depend on the classifier here.
function scriptedPolicy(decisions: RunDecision[]): RunPolicy {
  let i = 0;
  return { decide: (_ctx: RunFailureContext) => decisions[Math.min(i++, decisions.length - 1)]! };
}

await check("retries then completes; emits a retry event per retry", async () => {
  const { calls, evidence, restore } = stubFetch();
  let attempts = 0;
  const runItem = async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("socket hang up");
  };
  const policy = scriptedPolicy([
    { action: "retry", delayMs: 0, condition: "transport_error", summary: "retry 1" },
    { action: "retry", delayMs: 0, condition: "transport_error", summary: "retry 2" },
  ]);
  const poller = new ControlPlaneTaskPoller(cfg, runItem, undefined, { policy, ...noSleep });
  await (poller as unknown as { runOne(i: WorkItem): Promise<void> }).runOne(baseItem);
  restore();

  assert.equal(attempts, 3, "runItem should run 3 times (2 retries + success)");
  const p = paths(calls);
  assert.ok(p.includes("/complete"), "should complete");
  assert.ok(!p.includes("/fail"), "should not fail");
  const retryEvents = evidence.flatMap((e) => (e.events as { kind: string }[] | undefined) ?? []).filter((ev) => ev.kind === "retry");
  assert.equal(retryEvents.length, 2, "two retry evidence events");
});

await check("reroute rewrites routing for the next attempt", async () => {
  const { calls, restore } = stubFetch();
  const seenModels: (string | undefined)[] = [];
  const runItem = async (item: WorkItem) => {
    seenModels.push(item.model);
    if (item.model !== "sonnet") throw new Error("credit balance too low");
  };
  const policy = scriptedPolicy([
    { action: "reroute", delayMs: 0, condition: "credits_exhausted", routing: { model: "sonnet" }, ref: "sonnet", rerouteCount: 1, summary: "reroute" },
  ]);
  const poller = new ControlPlaneTaskPoller(cfg, runItem, undefined, { policy, ...noSleep });
  await (poller as unknown as { runOne(i: WorkItem): Promise<void> }).runOne(baseItem);
  restore();

  assert.deepEqual(seenModels, [undefined, "sonnet"], "second attempt runs with the rerouted model");
  assert.ok(paths(calls).includes("/complete"));
});

await check("park routes to needs-attention, not fail", async () => {
  const { calls, restore } = stubFetch();
  const runItem = async () => {
    throw new Error("401 Unauthorized");
  };
  const policy = scriptedPolicy([{ action: "park", condition: "auth_failed", summary: "parked" }]);
  const poller = new ControlPlaneTaskPoller(cfg, runItem, undefined, { policy, ...noSleep });
  await (poller as unknown as { runOne(i: WorkItem): Promise<void> }).runOne(baseItem);
  restore();

  const p = paths(calls);
  assert.ok(p.includes("/needs-attention"), "should park");
  assert.ok(!p.includes("/fail"), "should not fail");
  assert.ok(!p.includes("/complete"), "should not complete");
});

await check("per-automation attempt ceiling parks before a broader retry policy can continue", async () => {
  const { calls, evidence, restore } = stubFetch();
  let attempts = 0;
  const runItem = async () => {
    attempts += 1;
    throw new Error("socket hang up");
  };
  const policy = scriptedPolicy([
    { action: "retry", delayMs: 0, condition: "transport_error", summary: "retry" },
  ]);
  const poller = new ControlPlaneTaskPoller(cfg, runItem, undefined, { policy, ...noSleep });
  await (poller as unknown as { runOne(i: WorkItem): Promise<void> }).runOne({ ...baseItem, maxAttempts: 1 });
  restore();

  assert.equal(attempts, 1, "the hard ceiling must prevent a second attempt");
  assert.ok(paths(calls).includes("/needs-attention"), "the run should park for review");
  assert.ok(!paths(calls).includes("/fail"), "reaching the ceiling is actionable, not a silent failure");
  assert.match(JSON.stringify(evidence), /Attempt limit reached \(1\)/);
});

await check("give_up fails the run (historical path)", async () => {
  const { calls, restore } = stubFetch();
  const runItem = async () => {
    throw new Error("mystery");
  };
  const policy = scriptedPolicy([{ action: "give_up", condition: "unknown" }]);
  const poller = new ControlPlaneTaskPoller(cfg, runItem, undefined, { policy, ...noSleep });
  await (poller as unknown as { runOne(i: WorkItem): Promise<void> }).runOne(baseItem);
  restore();

  assert.ok(paths(calls).includes("/fail"), "should fail");
});

await check("with no policy injected, any throw still fails the run", async () => {
  const { calls, restore } = stubFetch();
  const runItem = async () => {
    throw new Error("boom");
  };
  const poller = new ControlPlaneTaskPoller(cfg, runItem, undefined); // no options
  await (poller as unknown as { runOne(i: WorkItem): Promise<void> }).runOne(baseItem);
  restore();

  assert.ok(paths(calls).includes("/fail"), "back-compat: no policy → fail");
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\ncontrol-plane-policy: all tests passed");
