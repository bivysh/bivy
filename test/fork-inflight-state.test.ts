// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { test } from "node:test";
import assert from "node:assert/strict";

import { describeInFlightState } from "../src/session/fork-standup.js";
import { buildForkBundle } from "../src/session/fork.js";
import type { AgentRuntime } from "../src/runtime/types.js";

test("describeInFlightState: nothing in flight → no notice", () => {
  assert.equal(describeInFlightState(undefined), undefined);
  assert.equal(describeInFlightState({}), undefined);
  assert.equal(describeInFlightState({ pendingApprovals: [] }), undefined);
});

test("describeInFlightState: pending approvals are disclosed with tool names", () => {
  const msg = describeInFlightState({ pendingApprovals: [{ toolName: "bash" }, { toolName: "write" }] });
  assert.match(msg ?? "", /2 pending tool approvals/);
  assert.match(msg ?? "", /bash, write/);
  assert.match(msg ?? "", /re-issue/);
});

test("describeInFlightState: singular wording + working turn", () => {
  assert.match(describeInFlightState({ pendingApprovals: [{ toolName: "bash" }] }) ?? "", /1 pending tool approval\b/);
  assert.match(describeInFlightState({ working: true }) ?? "", /unfinished turn/);
  const both = describeInFlightState({ working: true, pendingApprovals: [{ toolName: "bash" }] });
  assert.match(both ?? "", /pending tool approval.* and an unfinished turn/);
});

test("describeInFlightState: caps the tool list and marks the overflow", () => {
  const msg = describeInFlightState({ pendingApprovals: [{ toolName: "a" }, { toolName: "b" }, { toolName: "c" }, { toolName: "d" }] });
  assert.match(msg ?? "", /a, b, c, …/);
});

test("buildForkBundle carries in-flight state through to the bundle", () => {
  const runtime = { id: "pi", capabilities: {}, readMessages: undefined } as unknown as AgentRuntime;
  const bundle = buildForkBundle({
    runtime,
    record: { sourceSessionId: "s", runtimeId: "pi", workspace: "/w", cwd: "/w" },
    liveMessages: [{ role: "user", content: "hi" }] as any,
    state: { working: true, pendingApprovals: [{ toolName: "bash", requestId: "r1" }] },
  });
  assert.deepEqual(bundle.state, { working: true, pendingApprovals: [{ toolName: "bash", requestId: "r1" }] });
});

test("buildForkBundle omits state when none is provided", () => {
  const runtime = { id: "pi", capabilities: {} } as unknown as AgentRuntime;
  const bundle = buildForkBundle({
    runtime,
    record: { sourceSessionId: "s", runtimeId: "pi", workspace: "/w", cwd: "/w" },
    liveMessages: [] as any,
  });
  assert.equal(bundle.state, undefined);
});

test("an in-flight fork does not use a stale native snapshot", () => {
  const runtime = {
    id: "pi",
    capabilities: { forkTransport: true },
    exportForFork: () => ({ runtimeId: "pi", kind: "native", data: { stale: true } }),
  } as unknown as AgentRuntime;
  const bundle = buildForkBundle({
    runtime,
    sessionFile: "/source.json",
    record: { sourceSessionId: "s", runtimeId: "pi", workspace: "/w", cwd: "/w" },
    liveMessages: [{ role: "user", content: "latest prompt" }] as any,
    state: { working: true },
  });
  assert.equal(bundle.native, undefined);
  assert.equal(bundle.normalized.turns[0]?.text, "latest prompt");
});
