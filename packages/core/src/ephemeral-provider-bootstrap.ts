// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Shared projections used to bootstrap equivalent Bivy nodes on each substrate.

import { clampTtlMinutes } from "./ephemeral-lifecycle.js";
import type { BootstrapOpts } from "./ephemeral-provider-ports.js";
import { shq } from "./ephemeral-provider-utils.js";

function indentJson(json: string, pad: string): string {
  return json.split("\n").map((line) => pad + line).join("\n");
}


/** The relay enrollment blob written to `/etc/bivy/relay.json`. The daemon reads
 *  it on boot (`startRelayIfConfigured` in src/server.ts) and dials the relay
 *  with no interactive `bivy setup` — the node was already enrolled by the
 *  launching device. */
export function bivyRelayJson(opts: BootstrapOpts): string {
  return JSON.stringify({
    url: opts.relayUrl,
    enrollmentToken: opts.enrollmentToken,
    e2eKey: opts.e2eKeyB64,
    controlPlaneUrl: opts.controlPlaneUrl,
    clientBaseUrl: opts.controlPlaneUrl,
  });
}

/** The `export`s the daemon needs in its runtime env. `BIVY_DATA_DIR` points at
 *  the pre-baked `/etc/bivy` (relay.json + state); the rest are independently
 *  optional (repo, hosted-queue opt-in, routing label, GitHub token). Shared by
 *  the cloud-init (Hetzner/EC2) and Fly bootstraps so a node's env is identical
 *  however it was launched. */
function bivyBootstrapExports(opts: BootstrapOpts): string[] {
  // Every supported ephemeral provider is a destroy lane. The daemon learns
  // that it is disposable so it can snapshot and end the machine once idle.
  const ephemeral = opts.lifecycle !== "persistent" && Boolean(opts.provider);
  return [
    "export BIVY_DATA_DIR=/etc/bivy",
    opts.repo ? `export BIVY_REPO=${shq(opts.repo)}` : "",
    opts.hostedTasks ? `export BIVY_GITHUB_HOSTED_TASKS=1` : "",
    opts.hostedCredentialCustody ? `export BIVY_HOSTED_CREDENTIAL_CUSTODY=1` : "",
    opts.hostedCredentialPublisher ? `export BIVY_HOSTED_CREDENTIAL_PUBLISH=1` : "",
    opts.nodeLabel ? `export BIVY_NODE_LABEL=${shq(opts.nodeLabel)}` : "",
    opts.githubToken ? `export BIVY_GITHUB_TOKEN=${shq(opts.githubToken)}` : "",
    opts.hostedMint ? `export BIVY_HOSTED_MINT=1` : "",
    ephemeral ? `export BIVY_EPHEMERAL=1` : "",
    ephemeral ? `export BIVY_EPHEMERAL_PROVIDER=${shq(opts.provider)}` : "",
    ephemeral ? `export BIVY_EPHEMERAL_TTL_MIN=${clampTtlMinutes(opts.ttlMinutes)}` : "",
    ephemeral && opts.teardownOnAgentFinish ? `export BIVY_TEARDOWN_ON_FINISH=1` : "",
    ephemeral && opts.restoreSessionId ? `export BIVY_RESTORE=${shq(opts.restoreSessionId)}` : "",
  ].filter(Boolean);
}

/** `/etc/bivy/start.sh` — exports the runtime env then runs the daemon in the
 *  FOREGROUND (`exec bivy start`). This is the piece that was missing: the
 *  installer only *installs* Bivy, it never starts the node when there's no TTY
 *  (a headless, pre-enrolled machine). cloud-init runs this under `systemd-run`
 *  (a VM stays up on its own); Fly runs it as the machine's init process (a
 *  container needs a blocking foreground process or it exits and is destroyed).
 *  PATH is set explicitly because a non-login `systemd-run`/container shell
 *  doesn't source the rc file the installer appends BIN_DIR to. */
export function bivyStartScript(opts: BootstrapOpts): string {
  const exports = bivyBootstrapExports(opts)
    .map((line) => `${line}\n`)
    .join("");
  return (
    "#!/bin/bash\n" +
    'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin:$PATH"\n' +
    // npm keeps dependency executables beside Bivy's package, not necessarily
    // in the global bin directory. A login shell may also replace the image's
    // ENV PATH, so derive this location from the installed bivy executable at
    // boot instead of relying on Docker environment inheritance.
    'BIVY_CLI="$(readlink -f "$(command -v bivy)")"\n' +
    'BIVY_PACKAGE_DIR="$(dirname "$(dirname "$BIVY_CLI")")"\n' +
    'if [ -d "$BIVY_PACKAGE_DIR/node_modules/.bin" ]; then export PATH="$BIVY_PACKAGE_DIR/node_modules/.bin:$PATH"; fi\n' +
    exports +
    "exec bivy start\n"
  );
}

/** Best-effort telemetry must never block boot or expose bootstrap material in
 * logs. This is shared by container and cloud-init startup. */
export function bivyBootstrapStatusCommand(opts: BootstrapOpts, phase: "booting" | "installing" | "starting" | "failed"): string {
  return `curl --connect-timeout 2 --max-time 3 -fsS -X POST -H 'content-type: application/json' -H ${shq(`authorization: Bearer ${opts.enrollmentToken}`)} --data ${shq(JSON.stringify({ phase }))} ${shq(`${opts.controlPlaneUrl.replace(/\/$/, "")}/node/bootstrap-status`)} >/dev/null 2>&1 || true`;
}

export function buildBootstrapUserData(opts: BootstrapOpts): string {
  const relay = bivyRelayJson(opts);
  const persistent = opts.lifecycle === "persistent";
  const ttl = clampTtlMinutes(opts.ttlMinutes);
  const installUrl = opts.installUrl || "https://bivy.sh/install.sh";
  const startScript = bivyStartScript(opts);
  const status = (phase: Parameters<typeof bivyBootstrapStatusCommand>[1]) => bivyBootstrapStatusCommand(opts, phase);
  // Arm cost protection BEFORE any network/install operation can hang.
  const ttlCommand = `systemd-run --on-active=${ttl}m --timer-property=AccuracySec=1s --unit=bivy-ttl shutdown -h now || (echo 'shutdown -h now' | at now + ${ttl} minutes) || setsid bash -c 'sleep ${ttl * 60}; shutdown -h now' </dev/null >/var/log/bivy-ttl.log 2>&1 &`;
  return (
    [
      "#cloud-config",
      "write_files:",
      "  - path: /etc/bivy/relay.json",
      "    permissions: '0600'",
      "    content: |",
      indentJson(relay, "      "),
      "  - path: /etc/bivy/start.sh",
      "    permissions: '0755'",
      "    content: |",
      indentJson(startScript, "      "),
      // Persistent machines must restart after a reboot, not just survive the
      // initial cloud-init process. Keep the unit on disk and enable it.
      ...(persistent ? [
        "  - path: /etc/systemd/system/bivy.service",
        "    permissions: '0644'",
        "    content: |",
        indentJson([
          "[Unit]",
          "Description=Bivy agent workspace",
          "Wants=network-online.target",
          "After=network-online.target",
          "StartLimitIntervalSec=0",
          "[Service]",
          "Type=simple",
          "Environment=HOME=/root",
          "WorkingDirectory=/root",
          "ExecStart=/etc/bivy/start.sh",
          "Restart=always",
          "RestartSec=5",
          "[Install]",
          "WantedBy=multi-user.target",
        ].join("\n"), "      "),
      ] : []),
      "runcmd:",
      ...(!persistent ? [`  - [ bash, -lc, ${JSON.stringify(ttlCommand)} ]`] : []),
      `  - [ bash, -lc, ${JSON.stringify(status("booting"))} ]`,
      // 1. Install Bivy (state lands in /etc/bivy via BIVY_DATA_DIR).
      `  - [ bash, -lc, ${JSON.stringify(`set -euo pipefail; ${status("installing")}; mkdir -p /etc/bivy && export BIVY_DATA_DIR=/etc/bivy && (command -v bivy >/dev/null 2>&1 || curl --connect-timeout 10 --max-time 120 -fsSL ${shq(installUrl)} | bash) || { ${status("failed")}; exit 1; }`)} ]`,
      // 2. Start the daemon. On a systemd VM a transient system unit keeps it
      `  - [ bash, -lc, ${JSON.stringify(status("starting"))} ]`,
      //    running after cloud-init's own unit exits (a bare backgrounded process
      //    would be cleaned up with cloud-final's cgroup); the setsid fallback
      //    covers a rare image without systemd-run.
      persistent
        ? `  - [ bash, -lc, ${JSON.stringify(`systemctl daemon-reload && systemctl enable --now bivy.service || { ${status("failed")}; exit 1; }`)} ]`
        : `  - [ bash, -lc, "systemd-run --unit=bivy --collect --property=Restart=on-failure /etc/bivy/start.sh || setsid bash /etc/bivy/start.sh </dev/null >/var/log/bivy.log 2>&1 &" ]`,

    ].join("\n") + "\n"
  );
}
