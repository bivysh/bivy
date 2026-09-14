// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { flyProvider, FLY_RUNNER_IMAGE } from "../src/ephemeral-providers/fly.js";
import { buildBootstrapUserData } from "../src/ephemeral-provider-bootstrap.js";
import type { ExecRequest, ExecFn } from "../src/ephemeral-provider-ports.js";

const bootstrap = { relayUrl: "wss://relay.invalid", controlPlaneUrl: "https://cp.invalid", enrollmentToken: "test-only", e2eKeyB64: "test-only", ttlMinutes: 5 };
const config = { slug: "test", attemptId: "attempt-test", region: "iad", size: "shared-2x-4gb", ttlMinutes: 5 };
async function provision(exec: ExecFn) {
  return flyProvider.provision({ exec, token: "test-only", config, bootstrap, userData: "" });
}
async function machineConfig() {
  let body: any;
  await provision(async (req) => {
    if (req.url.includes("graphql")) return { status: 200, body: { data: { organizations: { nodes: [{ slug: "test" }] } } } };
    if (req.method === "GET") return { status: 200, body: [] };
    if (req.url.endsWith("/machines")) { body = req.body; return { status: 201, body: { id: "test" } }; }
    return { status: 201, body: {} };
  });
  return body.config;
}

// Execute the actual generated shell, not assertions against shell substrings.
// Only filesystem locations/PATH and TTL are sandboxed; commands and control
// flow are unchanged. Provider/network/package manager effects are test stubs.
async function runBoot(mode: "prebuilt" | "install-fails" | "install-hangs" | "daemon-hangs") {
  const root = await mkdtemp(join(tmpdir(), "bivy-boot-"));
  try {
    const cfg = await machineConfig();
    const bin = join(root, "bin");
    await mkdir(bin);
    for (const command of ["bash", "mkdir", "chmod", "sleep", "readlink", "dirname"]) await symlink(`/usr/bin/${command}`, join(bin, command));
    const log = join(root, "events");
    const stub = async (name: string, script: string) => writeFile(join(bin, name), `#!/bin/bash\n${script}\n`, { mode: 0o755 });
    await stub("curl", 'echo curl >> "$TEST_LOG"; exit 22');
    await stub("apt-get", mode === "install-hangs" ? 'echo installing >> "$TEST_LOG"; sleep 30' : 'echo installing >> "$TEST_LOG"');
    if (mode === "prebuilt" || mode === "daemon-hangs") await stub("bivy", `echo daemon >> "$TEST_LOG"; ${mode === "daemon-hangs" ? "sleep 30" : "exit 0"}`);
    const replacePaths = (s: string) => s.replaceAll("/etc/bivy", join(root, "etc")).replaceAll("/workspace", join(root, "workspace")).replace(/^.*export PATH=.*$/m, `export PATH="${bin}"`);
    await mkdir(join(root, "etc"));
    for (const file of cfg.files) await writeFile(replacePaths(file.guest_path), replacePaths(Buffer.from(file.raw_value, "base64").toString()));
    const args = [...cfg.init.exec.slice(1)];
    args[0] = "--kill-after=0.1s";
    args[1] = "0.5";
    args[4] = replacePaths(args[4]);
    const result = spawnSync(cfg.init.exec[0], args, { env: { ...process.env, TEST_LOG: log }, timeout: 3000, encoding: "utf8" });
    return { status: result.status, error: result.error, events: await readFile(log, "utf8").catch(() => ""), stderr: result.stderr };
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("Fly executable bootstrap", () => {
  it("defaults to the public pinned runner", async () => {
    expect((await machineConfig()).image).toBe(FLY_RUNNER_IMAGE);
    expect(FLY_RUNNER_IMAGE).toMatch(/@sha256:[a-f0-9]{64}$/);
  });
  it("starts prebuilt Bivy without installing, despite unavailable telemetry", async () => {
    const result = await runBoot("prebuilt");
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.events).toContain("daemon");
    expect(result.events).not.toContain("installing");
  });
  it("failed installer aborts instead of launching an uninstalled daemon", async () => {
    const result = await runBoot("install-fails");
    expect(result.status).not.toBe(0);
    expect(result.events).toContain("installing");
    expect(result.events).not.toContain("daemon");
  });
  it.each(["install-hangs", "daemon-hangs"] as const)("TTL kills %s", async (mode) => {
    const result = await runBoot(mode);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(124);
  });
  it("VM TTL is armed before installation and curl pipelines fail closed", () => {
    const data = buildBootstrapUserData(bootstrap);
    expect(data.indexOf("--unit=bivy-ttl")).toBeLessThan(data.indexOf("apt-get") < 0 ? data.indexOf("--max-time 120") : data.indexOf("apt-get"));
    expect(data).toContain("set -euo pipefail");
  });
});

describe("Fly retry and cleanup safety", () => {
  it("adopts the same attempt after Fly's real 422 name-conflict response", async () => {
    let creates = 0;
    const originalTime = "2026-01-01T00:00:00Z";
    const machine = await provision(async (req) => {
      if (req.url.includes("graphql")) return { status: 200, body: { data: { organizations: { nodes: [{ slug: "test" }] } } } };
      if (req.method === "GET") return { status: 200, body: [{ id: "original", state: "started", created_at: originalTime, config: { metadata: { "bivy-attempt": config.attemptId } } }] };
      if (req.url.endsWith("/machines")) creates++;
      return { status: 422, body: { error: "Validation failed: Name has already been taken" } };
    });
    expect(machine.id).toBe("original");
    expect(machine.createdAt).toBe(originalTime);
    expect(creates).toBe(0);
  });
  it("does not interpret other 422 validation failures as an existing app", async () => {
    const calls: ExecRequest[] = [];
    await expect(provision(async (req) => {
      calls.push(req);
      if (req.url.includes("graphql")) return { status: 200, body: { data: { organizations: { nodes: [{ slug: "test" }] } } } };
      return { status: 422, body: { error: "Invalid organization" } };
    })).rejects.toThrow("create app");
    expect(calls.some((r) => r.url.endsWith("/machines"))).toBe(false);
  });
  it("does not create a duplicate when adoption inventory is unavailable", async () => {
    const calls: ExecRequest[] = [];
    await expect(provision(async (req) => {
      calls.push(req);
      if (req.url.includes("graphql")) return { status: 200, body: { data: { organizations: { nodes: [{ slug: "test" }] } } } };
      return req.method === "GET" ? { status: 503, body: {} } : { status: 409, body: {} };
    })).rejects.toThrow("check existing launch");
    expect(calls.some((r) => r.method === "POST" && r.url.endsWith("/machines"))).toBe(false);
  });
  it.each([{ inventory: [] }, { inventory: [{ id: "another-machine" }] }])("deletes only an empty dedicated app: %j", async ({ inventory }) => {
    const calls: ExecRequest[] = [];
    await flyProvider.destroy({ token: "test", machine: { id: "test", app: "bivy-test", provider: "fly", name: "test", region: "iad", status: "gone", ip: null, createdAt: "" }, exec: async (req) => {
      calls.push(req);
      return req.method === "GET" ? { status: 200, body: inventory } : { status: 404, body: {} };
    } });
    expect(calls.some((r) => r.method === "DELETE" && r.url.endsWith("/bivy-test"))).toBe(inventory.length === 0);
  });
});
