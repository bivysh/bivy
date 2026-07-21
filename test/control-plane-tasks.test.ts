import assert from "node:assert/strict";
import {
  resolveControlPlaneTaskConfig,
  ControlPlaneTaskPoller,
  type ControlPlaneTaskConfig,
  type WorkItem,
} from "../src/control-plane-tasks.js";

/**
 * Node side of the hosted work queue (E2/E4). Pure config resolution + the
 * claim→run→complete loop, exercised against a fetch stub (no network).
 */

let failures = 0;
const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

test("config: off unless enrolled AND issue pickup opted in", () => {
  // Not enrolled → off.
  assert.equal(resolveControlPlaneTaskConfig(undefined, {}), null);
  // Enrolled but not opted in → off.
  assert.equal(
    resolveControlPlaneTaskConfig({ controlPlaneUrl: "https://cp", enrollmentToken: "t" }, {}),
    null,
  );
  // Enrolled + opted in → on, with default label.
  const cfg = resolveControlPlaneTaskConfig(
    { controlPlaneUrl: "https://cp/", enrollmentToken: "t" },
    { BIVY_GITHUB_TASKS: "1" },
  );
  assert.ok(cfg);
  assert.equal(cfg!.controlPlaneUrl, "https://cp"); // trailing slash trimmed
  assert.deepEqual(cfg!.labels, ["bivy"]);
});

test("config: per-node label is added to the served set", () => {
  const cfg = resolveControlPlaneTaskConfig(
    { controlPlaneUrl: "https://cp", enrollmentToken: "t" },
    { BIVY_GITHUB_TASKS: "1", BIVY_GITHUB_LABEL: "bivy", BIVY_NODE_LABEL: "bivy/laptop" },
  );
  assert.deepEqual(cfg!.labels, ["bivy", "bivy/laptop"]);
  // A bare BIVY_NODE_LABEL suffix is normalised to a full "bivy/<x>" label.
  const bare = resolveControlPlaneTaskConfig(
    { controlPlaneUrl: "https://cp", enrollmentToken: "t" },
    { BIVY_GITHUB_TASKS: "1", BIVY_NODE_LABEL: "laptop" },
  );
  assert.deepEqual(bare!.labels, ["bivy", "bivy/laptop"]);
});

test("config: the node auto-serves bivy/<its-name> without any manual label", () => {
  // Just the node's own name → it serves the shared queue AND its own label, so
  // a default node / bivy/<node> / "on <node>" routed to its name is picked up.
  const cfg = resolveControlPlaneTaskConfig(
    { controlPlaneUrl: "https://cp", enrollmentToken: "t" },
    { BIVY_GITHUB_TASKS: "1" },
    "hetzner",
  );
  assert.deepEqual(cfg!.labels, ["bivy", "bivy/hetzner"]);
  // Name + an explicit override both apply, de-duped.
  const both = resolveControlPlaneTaskConfig(
    { controlPlaneUrl: "https://cp", enrollmentToken: "t" },
    { BIVY_GITHUB_TASKS: "1", BIVY_NODE_LABEL: "bivy/extra" },
    "hetzner",
  );
  assert.deepEqual(both!.labels, ["bivy", "bivy/hetzner", "bivy/extra"]);
});

test("poller: claims then runs then completes; skips items lost to another node", async () => {
  const cfg: ControlPlaneTaskConfig = {
    controlPlaneUrl: "https://cp",
    enrollmentToken: "tok",
    labels: ["bivy"],
    pollMs: 60_000,
  };
  const pending: WorkItem[] = [
    { id: "w1", label: "bivy", source: "slack", status: "pending", title: "do A" },
    { id: "w2", label: "bivy", source: "slack", status: "pending", title: "do B" },
  ];
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.includes("/node/work?")) {
      return { ok: true, json: async () => ({ items: pending }) } as Response;
    }
    if (url.includes("/claim")) {
      // w1 claim succeeds; w2 was taken by another node (409).
      const ok = url.includes("w1");
      return { ok, json: async () => ({}) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response; // complete
  }) as typeof fetch;

  const ran: string[] = [];
  const poller = new ControlPlaneTaskPoller(cfg, async (item) => {
    ran.push(item.id);
  });
  try {
    // Drive one tick directly (start() also sets an interval we don't want here).
    await (poller as unknown as { tick: () => Promise<void> }).tick();
  } finally {
    globalThis.fetch = original;
  }

  assert.deepEqual(ran, ["w1"], "only the successfully-claimed item runs");
  // w1: claim + complete; w2: claim only (lost), no complete.
  assert.ok(calls.includes("POST https://cp/node/work/w1/claim"));
  assert.ok(calls.includes("POST https://cp/node/work/w1/complete"));
  assert.ok(calls.includes("POST https://cp/node/work/w2/claim"));
  assert.ok(!calls.includes("POST https://cp/node/work/w2/complete"));
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\ncontrol-plane-tasks: all tests passed");
