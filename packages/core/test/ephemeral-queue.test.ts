// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import {
  buildBootstrapUserData,
  createGithubTaskTokenStore,
  ephemeralNodeLabel,
  memoryBackend,
} from "../src/ephemeral.js";

// Issue #532: a GitHub work-queue item can dispatch to an ephemeral server
// instead of an already-running node. These are the pieces of the ephemeral
// lifecycle that changed to make that possible — the bootstrap script opts the
// booted node into the hosted queue and gives it a deterministic routing
// label + (optional) GitHub token, all without ever touching the control plane.

describe("ephemeralNodeLabel", () => {
  it("strips the eph- prefix off a generated node id", () => {
    expect(ephemeralNodeLabel("eph-ab12cd34")).toBe("ab12cd34");
  });

  it("passes through a value with no eph- prefix unchanged", () => {
    expect(ephemeralNodeLabel("some-other-id")).toBe("some-other-id");
  });
});

describe("buildBootstrapUserData — hosted queue opt-in", () => {
  const base = {
    relayUrl: "wss://relay.bivy.sh",
    controlPlaneUrl: "https://app.bivy.sh",
    enrollmentToken: "enroll-tok",
    e2eKeyB64: "e2e-key",
  };

  it("omits the hosted-tasks/label/token exports by default (pre-#532 behavior unchanged)", () => {
    const userData = buildBootstrapUserData(base);
    expect(userData).not.toContain("BIVY_GITHUB_HOSTED_TASKS");
    expect(userData).not.toContain("BIVY_NODE_LABEL");
    expect(userData).not.toContain("BIVY_GITHUB_TOKEN");
  });

  it("exports BIVY_GITHUB_HOSTED_TASKS, BIVY_NODE_LABEL and BIVY_GITHUB_TOKEN when opted in", () => {
    const userData = buildBootstrapUserData({
      ...base,
      hostedTasks: true,
      nodeLabel: "ab12cd34",
      githubToken: "ghp_abc123",
    });
    expect(userData).toContain("export BIVY_GITHUB_HOSTED_TASKS=1");
    expect(userData).toContain("export BIVY_NODE_LABEL='ab12cd34'");
    expect(userData).toContain("export BIVY_GITHUB_TOKEN='ghp_abc123'");
    // Still runs the installer with BIVY_DATA_DIR set, same as before.
    expect(userData).toContain("export BIVY_DATA_DIR=/etc/bivy");
    expect(userData).toContain("curl -fsSL");
  });

  it("single-quotes a token so shell metacharacters can't break out of the export", () => {
    const userData = buildBootstrapUserData({ ...base, hostedTasks: true, githubToken: "a'b$(rm -rf /)" });
    // shq() escapes embedded single quotes as '\'' — the token must never appear
    // unescaped in a way that lets it terminate the quoted string early.
    expect(userData).toContain(String.raw`export BIVY_GITHUB_TOKEN='a'\''b$(rm -rf /)'`);
  });

  it("combines with the existing repo export unchanged", () => {
    const userData = buildBootstrapUserData({ ...base, repo: "owner/repo", hostedTasks: true, nodeLabel: "slug1" });
    expect(userData).toContain("export BIVY_REPO='owner/repo'");
    expect(userData).toContain("export BIVY_GITHUB_HOSTED_TASKS=1");
  });
});

describe("createGithubTaskTokenStore", () => {
  it("round-trips a token through a fresh backend", async () => {
    const store = createGithubTaskTokenStore(memoryBackend());
    expect(await store.get()).toBe("");
    await store.set("ghp_xyz");
    expect(await store.get()).toBe("ghp_xyz");
    await store.remove();
    expect(await store.get()).toBe("");
  });

  it("trims the token and rejects an empty one", async () => {
    const store = createGithubTaskTokenStore(memoryBackend());
    await store.set("  ghp_padded  ");
    expect(await store.get()).toBe("ghp_padded");
    await expect(store.set("   ")).rejects.toThrow("cannot be empty");
  });
});
