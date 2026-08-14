// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCapabilitiesController, type CapabilitiesControllerDeps } from "../src/controllers/capabilities.js";
import type { CapabilityAgentSummary, CapabilityPluginSummary, CapabilityProbeResult } from "../src/capabilities.js";

const AGENTS: CapabilityAgentSummary[] = [
  { id: "claude-code-sdk", label: "Claude Code", kind: "maintained", installed: true, supportTier: "supported" },
  { id: "my-custom-agent", label: "My Custom Agent", kind: "custom", installed: false },
];
const PLUGINS: CapabilityPluginSummary[] = [{ id: "p1", valid: true, agentCount: 1 }];

function baseDeps(overrides: Partial<CapabilitiesControllerDeps> = {}): CapabilitiesControllerDeps {
  return {
    listAgents: () => AGENTS,
    listConfiguredProviderIds: () => ["anthropic"],
    listLocalEndpoints: () => [{ id: "ollama", modelCount: 1 }],
    listPlugins: () => PLUGINS,
    countWorkspaces: () => 2,
    probeDocker: async () => ({ state: "available", detail: "Docker 27.0.0" }),
    probeGpu: async () => ({ state: "unknown" }),
    ...overrides,
  };
}

// --- assembly from injected canonical-store facts --------------------------

{
  const controller = createCapabilitiesController(baseDeps());
  const snapshot = await controller.getCapabilities();
  assert.equal(snapshot.agents.maintained.length, 1);
  assert.equal(snapshot.agents.custom.length, 1);
  assert.deepEqual(snapshot.providers.configured, ["anthropic"]);
  assert.deepEqual(snapshot.providers.localEndpoints, { count: 1, withModels: 1 });
  assert.equal(snapshot.plugins.length, 1);
  assert.equal(snapshot.workspaces.count, 2);
  assert.equal(snapshot.os.platform, os.platform());
  assert.equal(snapshot.docker.state, "available");
  assert.equal(snapshot.gpu.state, "unknown");
}

// --- a probe that rejects degrades to "unknown", never throws --------------

{
  const controller = createCapabilitiesController(baseDeps({
    probeDocker: async () => { throw new Error("boom"); },
  }));
  const snapshot = await controller.getCapabilities();
  assert.deepEqual(snapshot.docker, { state: "unknown" });
}

// --- probes are cached within the TTL and re-run once it elapses -----------

{
  let calls = 0;
  let clock = 0;
  const controller = createCapabilitiesController(baseDeps({
    probeDocker: async () => { calls += 1; return { state: "available", detail: `call-${calls}` }; },
    now: () => clock,
  }));
  await controller.getCapabilities();
  await controller.getCapabilities();
  assert.equal(calls, 1, "second call within the TTL window must reuse the cached probe");

  clock += 30_001; // past the 30s cache TTL
  const snapshot = await controller.getCapabilities();
  assert.equal(calls, 2, "a call after the TTL elapses must re-probe");
  assert.equal(snapshot.docker.detail, "call-2");
}

// --- a real, unoverridden probe times out against a hung binary ------------
// Exercises the actual execFile timeout path (not an injected fake), so a
// probe that genuinely hangs cannot block the endpoint/CLI it feeds.

{
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-capabilities-test-"));
  try {
    fs.writeFileSync(path.join(fakeBin, "docker"), "#!/usr/bin/env bash\nsleep 5\n", { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    try {
      const controller = createCapabilitiesController(baseDeps({ probeDocker: undefined }));
      const start = Date.now();
      const snapshot = await controller.getCapabilities();
      const elapsedMs = Date.now() - start;
      assert.equal(snapshot.docker.state, "unknown");
      assert.match(snapshot.docker.detail ?? "", /timed out/);
      assert.ok(elapsedMs < 4000, `hung docker binary must be killed by the probe timeout, took ${elapsedMs}ms`);
    } finally {
      process.env.PATH = originalPath;
    }
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
}

// --- a missing binary is reported as conclusively unavailable, not unknown -

{
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-capabilities-test-empty-"));
  try {
    const originalPath = process.env.PATH;
    process.env.PATH = fakeBin;
    try {
      const controller = createCapabilitiesController(baseDeps({ probeDocker: undefined }));
      const snapshot = await controller.getCapabilities();
      assert.equal(snapshot.docker.state, "unavailable");
      assert.match(snapshot.docker.detail ?? "", /not installed/);
    } finally {
      process.env.PATH = originalPath;
    }
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
}

// --- GPU: macOS is reported available without a deeper vendor scan ---------

{
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  try {
    const controller = createCapabilitiesController(baseDeps({ probeGpu: undefined }));
    const snapshot: { gpu: CapabilityProbeResult } = await controller.getCapabilities();
    assert.equal(snapshot.gpu.state, "available");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
}

console.log("capabilities controller: assembly, probe failure/timeout, caching, and GPU platform shortcut passed");
