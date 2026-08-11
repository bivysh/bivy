// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import { RuntimeHost } from "../src/runtime/host.js";
import { RemoteRuntime } from "../src/runtime/remote.js";

function makeHost() {
  return new RuntimeHost({ credsDir: "/tmp/bivy-test-pi", piDir: "/tmp/bivy-test-pi", sessionsDir: "/tmp/bivy-test-pi/sessions" });
}

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

test("flag off → get() returns the in-process runtime (default), not remote", () => {
  withEnv({ BIVY_REMOTE_RUNTIME: undefined, BIVY_REMOTE_RUNTIME_ADDR: undefined }, () => {
    const rt = makeHost().get("claude-code-sdk", "pi");
    assert.equal(rt.id, "claude-code-sdk");
    assert.ok(!(rt instanceof RemoteRuntime), "in-process path when the flag is off");
  });
});

test("flag on (all) + addr → get() returns a RemoteRuntime with registry capabilities", () => {
  withEnv({ BIVY_REMOTE_RUNTIME: "1", BIVY_REMOTE_RUNTIME_ADDR: "unix:/tmp/bivy-agent.sock" }, () => {
    const host = makeHost();
    const rt = host.get("claude-code-sdk", "pi");
    assert.ok(rt instanceof RemoteRuntime, "remote path when the flag is on");
    assert.equal(rt.id, "claude-code-sdk");
    assert.equal(rt.displayName, "Claude Code");
    // Capabilities come from the registry (CLAUDE_CAPABILITIES), not a connection.
    assert.equal(rt.capabilities.toolInterception, true);
    assert.equal(rt.capabilities.resume, true);
    // Cached: same instance on a second lookup (no reconnect churn).
    assert.equal(host.get("claude-code-sdk", "pi"), rt);
    // Stage 2: the agent-service address is surfaced so the daemon can advertise
    // a session's host for re-attach routing.
    assert.equal((rt as RemoteRuntime).agentServiceAddress, "unix:/tmp/bivy-agent.sock");
  });
});

test("per-runtime allowlist only routes the named runtimes remotely", () => {
  withEnv({ BIVY_REMOTE_RUNTIME: "generic-cli", BIVY_REMOTE_RUNTIME_ADDR: "unix:/tmp/x.sock" }, () => {
    const host = makeHost();
    // generic-cli is enabled → remote, and this works even though
    // BIVY_AGENT_COMMAND is unset locally (the remote path skips makeRuntime).
    const remote = host.get("generic-cli", "pi");
    assert.ok(remote instanceof RemoteRuntime);
    assert.equal(remote.id, "generic-cli");
    // claude-code-sdk is NOT in the allowlist → in-process.
    const local = host.get("claude-code-sdk", "pi");
    assert.ok(!(local instanceof RemoteRuntime));
  });
});

test("getRemoteAt routes to a SPECIFIC address (Stage 3 per-session routing) and caches by address", () => {
  // No env flag needed: getRemoteAt is the explicit per-session route used to
  // adopt a session that may live on a different service than the node default.
  withEnv({ BIVY_REMOTE_RUNTIME: undefined, BIVY_REMOTE_RUNTIME_ADDR: undefined }, () => {
    const host = makeHost();
    const a = host.getRemoteAt("claude-code-sdk", "unix:/run/a.sock");
    const b = host.getRemoteAt("claude-code-sdk", "10.0.0.4:4711");
    assert.ok(a instanceof RemoteRuntime);
    assert.ok(b instanceof RemoteRuntime);
    assert.equal((a as RemoteRuntime).agentServiceAddress, "unix:/run/a.sock");
    assert.equal((b as RemoteRuntime).agentServiceAddress, "10.0.0.4:4711");
    assert.notEqual(a, b, "distinct addresses → distinct runtime facades");
    // Cached per address: the same address returns the same instance.
    assert.equal(host.getRemoteAt("claude-code-sdk", "unix:/run/a.sock"), a);
  });
});

test("flag on but no address → stays in-process (nowhere to connect)", () => {
  withEnv({ BIVY_REMOTE_RUNTIME: "1", BIVY_REMOTE_RUNTIME_ADDR: undefined }, () => {
    const rt = makeHost().get("claude-code-sdk", "pi");
    assert.ok(!(rt instanceof RemoteRuntime));
  });
});

test("BIVY_REMOTE_RUNTIME=0 is treated as off", () => {
  withEnv({ BIVY_REMOTE_RUNTIME: "0", BIVY_REMOTE_RUNTIME_ADDR: "unix:/tmp/x.sock" }, () => {
    const rt = makeHost().get("claude-code-sdk", "pi");
    assert.ok(!(rt instanceof RemoteRuntime));
  });
});
