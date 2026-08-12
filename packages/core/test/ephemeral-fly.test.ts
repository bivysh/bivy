// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { ephemeralAdapter, unb64, type BootstrapOpts, type ExecRequest, type ExecResult } from "../src/index.js";

// A Fly Machine is an OCI image in a microVM, not a cloud-init VM: the shared
// `#cloud-config` user_data is never executed, and a bare `ubuntu:24.04` runs
// `/bin/bash`, which exits immediately — so with `restart: no` + `auto_destroy`
// the machine boots and self-destructs before Bivy is ever installed (the
// reported "app has no machines" / node-offline bug). The adapter must instead
// write the bootstrap files and run the daemon as a blocking foreground process.

const BOOTSTRAP: BootstrapOpts = {
  relayUrl: "wss://relay.bivy.sh",
  controlPlaneUrl: "https://app.bivy.sh",
  enrollmentToken: "enroll-tok",
  e2eKeyB64: "e2e-key-b64",
  ttlMinutes: 90,
  repo: "owner/repo",
};

const utf8Decode = (raw: string) => new TextDecoder().decode(unb64(raw));

type FlyFile = { guest_path: string; raw_value: string };
type FlyMachineBody = {
  region: string;
  config: {
    image?: string;
    auto_destroy: boolean;
    restart: { policy: string };
    init: { exec?: string[]; user_data?: string };
    files?: FlyFile[];
  };
};
const machineConfig = (req: ExecRequest) => (req.body as FlyMachineBody).config;

/** Fake Fly transport: 200 on app create, returns a machine on machine create,
 *  and records the machine-create body so the test can assert its config. */
function fakeFlyExec() {
  const calls: ExecRequest[] = [];
  const exec = async (req: ExecRequest): Promise<ExecResult> => {
    calls.push(req);
    if (req.url === "https://api.machines.dev/v1/apps") return { status: 201, body: {} };
    if (/\/machines$/.test(req.url)) return { status: 200, body: { id: "abc123", state: "starting" } };
    return { status: 404, body: null };
  };
  return { exec, calls };
}

describe("fly adapter — provision", () => {
  it("boots via files + a foreground init.exec, not cloud-init user_data", async () => {
    const { exec, calls } = fakeFlyExec();
    const adapter = ephemeralAdapter("fly")!;
    const machine = await adapter.provision({
      exec,
      token: "fly-token",
      userData: "#cloud-config\nruncmd: []\n",
      bootstrap: BOOTSTRAP,
      config: { slug: "abc123", region: "fra", size: "shared-2x-4gb", image: "ghcr.io/bivysh/bivy-ephemeral-runner:sha-test", ttlMinutes: 90 },
    });

    expect(machine).toMatchObject({ id: "abc123", provider: "fly", app: "bivy-abc123", region: "fra" });

    const create = calls.find((c) => /\/machines$/.test(c.url))!;
    const cfg = machineConfig(create);

    // The machine still self-destructs when its process exits — but now that's
    // the daemon finishing, not a bare shell exiting on boot.
    expect(cfg.auto_destroy).toBe(true);
    expect(cfg.restart).toEqual({ policy: "no" });
    expect(cfg.image).toBe("ghcr.io/bivysh/bivy-ephemeral-runner:sha-test");

    // The broken cloud-init path must be gone.
    expect(cfg.init.user_data).toBeUndefined();

    // relay.json + start.sh are materialized as base64 files.
    const files = cfg.files!;
    const relay = files.find((f) => f.guest_path === "/etc/bivy/relay.json")!;
    const start = files.find((f) => f.guest_path === "/etc/bivy/start.sh")!;
    expect(relay).toBeTruthy();
    expect(start).toBeTruthy();

    // relay.json carries the enrollment the daemon dials the relay with.
    expect(JSON.parse(utf8Decode(relay.raw_value))).toMatchObject({
      url: "wss://relay.bivy.sh",
      enrollmentToken: "enroll-tok",
      e2eKey: "e2e-key-b64",
      controlPlaneUrl: "https://app.bivy.sh",
    });

    // start.sh exports the runtime env and runs the daemon in the foreground.
    const startScript = utf8Decode(start.raw_value);
    expect(startScript).toContain("export BIVY_DATA_DIR=/etc/bivy");
    expect(startScript).toContain("export BIVY_REPO='owner/repo'");
    expect(startScript).toContain("exec bivy start");

    // init.exec uses preinstalled Bivy when present, falls back to installing
    // curl+Bivy for a generic image, then
    // hands the foreground to start.sh under a TTL timeout (90 min → 5400s), the
    // backstop that replaces the VM shutdown. `pipefail` makes a failed install
    // abort loudly instead of limping on to a doomed `bivy start`.
    const script = cfg.init.exec![2];
    expect(cfg.init.exec[0]).toBe("/bin/bash");
    expect(cfg.init.exec[1]).toBe("-lc");
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("command -v bivy");
    expect(script).toContain("apt-get install -y -qq curl ca-certificates");
    expect(script).toContain("curl -fsSL");
    expect(script).toContain("exec timeout 5400 bash /etc/bivy/start.sh");
  });

  it("falls back to cloud-init user_data when no structured bootstrap is given", async () => {
    const { exec, calls } = fakeFlyExec();
    const adapter = ephemeralAdapter("fly")!;
    await adapter.provision({
      exec,
      token: "fly-token",
      userData: "#cloud-config\nruncmd: []\n",
      config: { slug: "abc123", region: "fra", size: "shared-1x-2gb", ttlMinutes: 60 },
    });
    const create = calls.find((c) => /\/machines$/.test(c.url))!;
    const cfg = machineConfig(create);
    expect(cfg.init).toEqual({ user_data: "#cloud-config\nruncmd: []\n" });
    expect(cfg.files).toBeUndefined();
  });
});
