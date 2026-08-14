import assert from "node:assert/strict";
import {
  resolveControlPlaneTaskConfig,
  ControlPlaneTaskPoller,
  failWork,
  reportEvidence,
  capabilityEligible,
  capabilityClaimDelayMs,
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

/** Poll `cond` until it's true (or throw after a timeout) — used to await async
 *  work that isn't tied to a single promise (e.g. a fire-and-forget task pool). */
async function waitFor(cond: () => boolean, { tries = 200, intervalMs = 5 } = {}): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!cond()) throw new Error("waitFor: condition never became true");
}

test("config: every enrolled node serves the hosted work queue", () => {
  // Not enrolled → off.
  assert.equal(resolveControlPlaneTaskConfig(undefined, {}), null);
  // Slack/webhook/schedule work must run without a GitHub-specific opt-in.
  const cfg = resolveControlPlaneTaskConfig(
    { controlPlaneUrl: "https://cp/", enrollmentToken: "t" },
    {},
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

test("config: this node's declared capabilities are carried into the poller config", () => {
  const cfg = resolveControlPlaneTaskConfig(
    { controlPlaneUrl: "https://cp", enrollmentToken: "t" },
    {},
    "laptop",
    ["gpu", "docker"],
  );
  assert.deepEqual(cfg!.capabilities, ["gpu", "docker"]);
  // No capabilities declared → an empty list, not undefined-shaped surprises.
  const bare = resolveControlPlaneTaskConfig({ controlPlaneUrl: "https://cp", enrollmentToken: "t" }, {});
  assert.deepEqual(bare!.capabilities, []);
});

test("capabilityEligible: hard block on a missing required tag; extras never matter", () => {
  assert.equal(capabilityEligible(["docker"], ["gpu"]), false);
  assert.equal(capabilityEligible(["gpu", "docker"], ["gpu"]), true);
  assert.equal(capabilityEligible([], undefined), true);
  assert.equal(capabilityEligible([], []), true);
});

test("capabilityClaimDelayMs: zero for ineligible/no-preference/full-match nodes; longer the fewer preferred tags match", () => {
  assert.equal(capabilityClaimDelayMs(["docker"], undefined), 0);
  assert.equal(capabilityClaimDelayMs(["docker"], []), 0);
  assert.equal(capabilityClaimDelayMs(["gpu", "docker"], ["gpu", "docker"]), 0, "full preferred match never waits");
  const none = capabilityClaimDelayMs([], ["gpu", "docker"], 2000, 4000);
  const half = capabilityClaimDelayMs(["gpu"], ["gpu", "docker"], 2000, 4000);
  assert.ok(half > 0 && half < none, "matching half the preferred tags waits less than matching none");
  assert.ok(none <= 4000, "delay is capped at maxMs");
  // Deterministic: no randomness, so repeated calls with the same inputs agree.
  assert.equal(capabilityClaimDelayMs(["gpu"], ["gpu", "docker", "private-net"]), capabilityClaimDelayMs(["gpu"], ["gpu", "docker", "private-net"]));
});

test("poller: a node lacking a required capability never contends for that item, but still claims others", async () => {
  const cfg: ControlPlaneTaskConfig = {
    controlPlaneUrl: "https://cp",
    enrollmentToken: "tok",
    labels: ["bivy"],
    pollMs: 60_000,
    capabilities: ["docker"], // no "gpu"
  };
  const pending: WorkItem[] = [
    { id: "gpu-job", label: "bivy", source: "slack", status: "pending", title: "needs a GPU", requiredCapabilities: ["gpu"] },
    { id: "plain-job", label: "bivy", source: "slack", status: "pending", title: "no special needs" },
  ];
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.includes("/node/work?")) return { ok: true, json: async () => ({ items: pending }) } as Response;
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;

  const ran: string[] = [];
  const poller = new ControlPlaneTaskPoller(cfg, async (item) => { ran.push(item.id); });
  try {
    await (poller as unknown as { tick: () => Promise<void> }).tick();
  } finally {
    globalThis.fetch = original;
  }

  assert.deepEqual(ran, ["plain-job"], "the GPU-requiring item is never run by a node lacking that capability");
  assert.ok(!calls.some((c) => c.includes("gpu-job")), "an ineligible node must never even attempt to claim it");
  assert.ok(calls.includes("POST https://cp/node/work/plain-job/claim"));
});

test("poller: adopts renamed-node labels without a restart", async () => {
  const cfg: ControlPlaneTaskConfig = {
    controlPlaneUrl: "https://cp",
    enrollmentToken: "tok",
    labels: ["bivy", "bivy/old-name"],
    pollMs: 60_000,
  };
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as typeof fetch;

  const poller = new ControlPlaneTaskPoller(cfg, async () => {});
  try {
    poller.setLabels(["bivy", "bivy/new-name"]);
    await waitFor(() => urls.length > 0);
  } finally {
    poller.stop();
    globalThis.fetch = original;
  }

  assert.equal(cfg.labels.includes("bivy/new-name"), true);
  assert.equal(cfg.labels.includes("bivy/old-name"), false);
  assert.ok(urls.some((url) => decodeURIComponent(url).includes("labels=bivy,bivy/new-name")));
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

// ---------------------------------------------------------------------------
// Items within a single tick must run CONCURRENTLY up to the cap (#116),
// mirroring the same fix in github-tasks.ts's GitHubTaskPoller. A prior
// version awaited each item's full run before even claiming the next one, so
// the concurrency cap was never really exercised within a tick.
// ---------------------------------------------------------------------------
test("poller: runs up to the concurrency cap in parallel, not one at a time", async () => {
  const cfg: ControlPlaneTaskConfig = {
    controlPlaneUrl: "https://cp",
    enrollmentToken: "tok",
    labels: ["bivy"],
    pollMs: 60_000,
  };
  const pending: WorkItem[] = [
    { id: "w1", label: "bivy", source: "slack", status: "pending", title: "do A" },
    { id: "w2", label: "bivy", source: "slack", status: "pending", title: "do B" },
    { id: "w3", label: "bivy", source: "slack", status: "pending", title: "do C" },
  ];
  const claimed: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    if (url.includes("/node/work?")) return { ok: true, json: async () => ({ items: pending }) } as Response;
    if (url.includes("/claim")) {
      const m = /\/node\/work\/([^/]+)\/claim$/.exec(url);
      if (method === "POST" && m) claimed.push(m[1]);
      return { ok: true, json: async () => ({}) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response; // complete
  }) as typeof fetch;

  let active = 0;
  let maxActive = 0;
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const poller = new ControlPlaneTaskPoller(
    cfg,
    async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      started.push(item.id);
      await new Promise<void>((resolve) => release.set(item.id, resolve));
      active--;
    },
    () => 2, // cap of 2 — the 3rd item must wait for a later tick
  );

  try {
    const tickPromise = (poller as unknown as { tick: () => Promise<void> }).tick();
    // Wait for both capped-in tasks to reach their "await release" point
    // before asserting — how many microtask hops that takes depends on the
    // stubbed fetch chain, so poll rather than guessing a fixed flush count.
    await waitFor(() => started.length >= 2);

    assert.deepEqual([...started].sort(), ["w1", "w2"], "only the first 2 (the cap) are claimed/started this tick");
    assert.equal(maxActive, 2, "both ran concurrently — not one fully finishing before the next starts");
    assert.deepEqual(claimed.sort(), ["w1", "w2"], "item w3 is left unclaimed for a later tick");

    release.get("w1")!();
    release.get("w2")!();
    await tickPromise;
  } finally {
    globalThis.fetch = original;
  }
});

test("poller: relay poke cancellation aborts active work without completing or failing", async () => {
  const cfg: ControlPlaneTaskConfig = { controlPlaneUrl: "https://cp", enrollmentToken: "tok", labels: ["bivy"], pollMs: 60_000 };
  const calls: string[] = [];
  const original = globalThis.fetch;
  let cancelHeartbeat = false;
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/heartbeat") && cancelHeartbeat) {
      return { ok: false, status: 409, json: async () => ({ reason: "cancelled" }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
  }) as typeof fetch;

  let started = false;
  let aborted = false;
  const poller = new ControlPlaneTaskPoller(cfg, async (_item, _report, signal) => {
    started = true;
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    });
  });

  try {
    const running = (poller as unknown as { runOne(i: WorkItem): Promise<void> }).runOne({ id: "cancel-poke", label: "bivy", source: "slack", status: "pending", title: "cancel me" });
    await waitFor(() => started);
    cancelHeartbeat = true;
    poller.poke("cancel-poke");
    await running;
  } finally {
    poller.stop();
    globalThis.fetch = original;
  }

  assert.equal(aborted, true, "the third-argument AbortSignal should be aborted");
  assert.equal(poller.inFlightCount(), 0, "the cancelled Run should release its in-flight slot");
  assert.ok(!calls.some((call) => call.endsWith("/complete")), "cancelled work must not complete");
  assert.ok(!calls.some((call) => call.endsWith("/fail")), "an abort must not be classified as failure");
});

test("poller: lost lease aborts active work without policy retry or a terminal transition", async () => {
  const cfg: ControlPlaneTaskConfig = { controlPlaneUrl: "https://cp", enrollmentToken: "tok", labels: ["bivy"], pollMs: 60_000 };
  const calls: string[] = [];
  const original = globalThis.fetch;
  let loseLease = false;
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/heartbeat") && loseLease) {
      return { ok: false, status: 409, json: async () => ({ error: "not owned" }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
  }) as typeof fetch;

  let attempts = 0;
  let decisions = 0;
  const poller = new ControlPlaneTaskPoller(cfg, async (_item, _report, signal) => {
    attempts += 1;
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }, undefined, {
    policy: {
      decide: () => {
        decisions += 1;
        return { action: "retry", condition: "transient", summary: "retry", delayMs: 0 };
      },
    },
  });

  try {
    const running = (poller as unknown as { runOne(i: WorkItem): Promise<void> }).runOne({ id: "lost-lease", label: "bivy", source: "slack", status: "pending", title: "lose me" });
    await waitFor(() => attempts === 1);
    loseLease = true;
    poller.poke("lost-lease");
    await running;
  } finally {
    poller.stop();
    globalThis.fetch = original;
  }

  assert.equal(attempts, 1, "lost ownership must not start another attempt");
  assert.equal(decisions, 0, "lease loss must bypass failure policy classification");
  assert.ok(!calls.some((call) => call.endsWith("/complete") || call.endsWith("/fail")), "lost work has no node terminal transition");
});

test("poller: periodic heartbeat catches cancellation and aborts active work", async () => {
  const cfg: ControlPlaneTaskConfig = { controlPlaneUrl: "https://cp", enrollmentToken: "tok", labels: ["bivy"], pollMs: 60_000 };
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/heartbeat")) {
      return { ok: false, status: 409, json: async () => ({ reason: "cancelled" }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
  }) as typeof fetch;

  let aborted = false;
  const poller = new ControlPlaneTaskPoller(cfg, async (_item, _report, signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    });
  }, undefined, { leaseHeartbeatMs: 5 });

  try {
    const running = (poller as unknown as { runOne(i: WorkItem): Promise<void> }).runOne({ id: "cancel-heartbeat", label: "bivy", source: "slack", status: "pending", title: "cancel me too" });
    // Keep a referenced test timer alive; production heartbeat timers are
    // deliberately unref'd so they never prevent clean process shutdown.
    await waitFor(() => aborted);
    await running;
  } finally {
    poller.stop();
    globalThis.fetch = original;
  }

  assert.equal(aborted, true);
  assert.equal(poller.inFlightCount(), 0);
  assert.ok(calls.some((call) => call.endsWith("/heartbeat")), "periodic lease renewal should observe cancellation");
  assert.ok(!calls.some((call) => call.endsWith("/complete") || call.endsWith("/fail")), "cancelled work has no node terminal transition");
});

test("A4: a failed work transition is logged, not swallowed", async () => {
  const cfg: ControlPlaneTaskConfig = { controlPlaneUrl: "https://cp", enrollmentToken: "t", labels: ["bivy"], pollMs: 60_000 };
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  const originalFetch = globalThis.fetch;

  try {
    // Network-level failure (fetch rejects).
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    await failWork(cfg, "w1"); // must not throw
    assert.ok(warnings.some((w) => w.includes("w1") && w.includes("fail")), `expected a warning naming the failed transition, got: ${warnings.join(" | ")}`);

    // Control-plane rejects the transition (non-ok response).
    warnings.length = 0;
    globalThis.fetch = (async () => new Response("", { status: 503 })) as typeof fetch;
    await failWork(cfg, "w2");
    assert.ok(warnings.some((w) => w.includes("w2") && w.includes("503")), `expected a warning with the rejection status, got: ${warnings.join(" | ")}`);

    // Evidence reports are logged the same way.
    warnings.length = 0;
    globalThis.fetch = (async () => { throw new Error("down"); }) as typeof fetch;
    await reportEvidence(cfg, "w3", { routingReason: "test" });
    assert.ok(warnings.some((w) => w.includes("w3") && w.includes("evidence")), `expected an evidence-report warning, got: ${warnings.join(" | ")}`);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
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
