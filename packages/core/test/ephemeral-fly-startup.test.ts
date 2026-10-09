// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { flyInit } from "../src/ephemeral-providers/fly.js";

const bootstrap = { relayUrl: "wss://relay.invalid", controlPlaneUrl: "https://cp.invalid", enrollmentToken: "test-only", e2eKeyB64: "test-only", ttlMinutes: 5 };
const machineConfig = async () => flyInit(bootstrap);

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
});
