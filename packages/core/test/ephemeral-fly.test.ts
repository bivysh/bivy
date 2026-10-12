// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { flyMachineBoot, unb64, type BootstrapOpts } from "../src/index.js";

// A Fly Machine is an OCI image in a microVM, not a cloud-init VM: a bare
// image runs `/bin/bash`, which exits immediately. The boot payload must write
// the bootstrap files and run the daemon as a blocking foreground process.

const BOOTSTRAP: BootstrapOpts = {
  relayUrl: "wss://relay.bivy.sh",
  controlPlaneUrl: "https://app.bivy.sh",
  enrollmentToken: "enroll-tok",
  e2eKeyB64: "e2e-key-b64",
  ttlMinutes: 90,
  repo: "owner/repo",
};

const utf8Decode = (raw: string) => new TextDecoder().decode(unb64(raw));

describe("fly machine boot payload", () => {
  it("writes relay.json + start.sh and runs the daemon as a bounded foreground init", () => {
    const boot = flyMachineBoot(BOOTSTRAP);
    const relay = boot.files.find((f) => f.guest_path === "/etc/bivy/relay.json")!;
    const start = boot.files.find((f) => f.guest_path === "/etc/bivy/start.sh")!;
    expect(JSON.parse(utf8Decode(relay.raw_value))).toMatchObject({
      url: "wss://relay.bivy.sh",
      enrollmentToken: "enroll-tok",
      e2eKey: "e2e-key-b64",
      controlPlaneUrl: "https://app.bivy.sh",
    });
    const startScript = utf8Decode(start.raw_value);
    expect(startScript).toContain("export BIVY_REPO='owner/repo'");
    expect(startScript).toContain("exec bivy start");

    // Preinstalled Bivy is used when present; a generic image installs curl and
    // Bivy first. The awake bound (90 min → 5400s) wraps the whole process.
    expect(boot.init.exec.slice(0, 5)).toEqual(["/usr/bin/timeout", "--kill-after=10s", "5400", "/bin/bash", "-c"]);
    const script = boot.init.exec[5]!;
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("command -v bivy");
    expect(script).toContain("apt-get install -y -qq curl ca-certificates");
    expect(script).toContain("/node/bootstrap-status");
    expect(script).toContain("exec bash /etc/bivy/start.sh");
    expect(script).not.toContain("/data/bivy");
  });

  it("a sleeping machine copies its fresh enrollment onto the persistent disk", () => {
    const script = flyMachineBoot({ ...BOOTSTRAP, provider: "fly", sleepOnIdle: true }).init.exec[5]!;
    expect(script).toContain("install -m 600 /etc/bivy/relay.json /data/bivy/relay.json");
  });
});
