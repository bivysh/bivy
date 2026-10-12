// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// The runtime env `/etc/bivy/start.sh` gives a booted node: what it serves,
// which credentials it may hold, and how it sleeps.
import { describe, expect, it } from "vitest";
import { bivyStartScript } from "../src/ephemeral-provider-bootstrap.js";
import type { BootstrapOpts } from "../src/index.js";

const base: BootstrapOpts = {
  relayUrl: "wss://relay.bivy.sh",
  controlPlaneUrl: "https://app.bivy.sh",
  enrollmentToken: "enroll-tok",
  e2eKeyB64: "e2e-key-b64",
  ttlMinutes: 90,
};
const start = (opts: Partial<BootstrapOpts> = {}) => bivyStartScript({ ...base, ...opts });

describe("bootstrap start.sh env", () => {
  it("runs the daemon in the foreground with Bivy's package-local tools on PATH", () => {
    const script = start();
    expect(script).toContain('BIVY_CLI="$(readlink -f "$(command -v bivy)")"');
    expect(script).toContain('export PATH="$BIVY_PACKAGE_DIR/node_modules/.bin:$PATH"');
    expect(script.trimEnd().endsWith("exec bivy start")).toBe(true);
    expect(script).not.toContain("BIVY_EPHEMERAL");
  });

  it("marks an ephemeral node and its awake bound", () => {
    const script = start({ provider: "fly", teardownOnAgentFinish: true, restoreSessionId: "sess-xyz" });
    expect(script).toContain("export BIVY_EPHEMERAL=1");
    expect(script).toContain("export BIVY_EPHEMERAL_PROVIDER='fly'");
    expect(script).toContain("export BIVY_EPHEMERAL_TTL_MIN=90");
    expect(script).toContain("export BIVY_TEARDOWN_ON_FINISH=1");
    expect(script).toContain("export BIVY_RESTORE='sess-xyz'");
    expect(start({ provider: "fly" })).not.toMatch(/BIVY_TEARDOWN_ON_FINISH|BIVY_RESTORE/);
  });

  it("puts a sleeping machine's data, workspace and HOME on its persistent disk", () => {
    const script = start({ provider: "fly", sleepOnIdle: true });
    expect(script).toContain("export BIVY_EPHEMERAL_SLEEP=1");
    expect(script).toContain("export BIVY_DATA_DIR=/data/bivy");
    expect(script).toContain("export BIVY_WORKSPACE=/data/workspace");
    expect(script).toContain("export HOME=/data/home");
    expect(start({ provider: "fly" })).toContain("export BIVY_DATA_DIR=/etc/bivy");
  });

  it("opts into hosted work only when asked", () => {
    expect(start()).not.toMatch(/BIVY_GITHUB_HOSTED_TASKS|BIVY_NODE_LABEL|BIVY_GITHUB_TOKEN/);
    const script = start({ repo: "owner/repo", hostedTasks: true, nodeLabel: "ab12cd34", hostedMint: true });
    expect(script).toContain("export BIVY_REPO='owner/repo'");
    expect(script).toContain("export BIVY_GITHUB_HOSTED_TASKS=1");
    expect(script).toContain("export BIVY_NODE_LABEL='ab12cd34'");
    expect(script).toContain("export BIVY_HOSTED_MINT=1");
  });

  it("single-quotes a token so shell metacharacters can't break out of the export", () => {
    expect(start({ githubToken: "a'b$(rm -rf /)" })).toContain(String.raw`export BIVY_GITHUB_TOKEN='a'\''b$(rm -rf /)'`);
  });
});
