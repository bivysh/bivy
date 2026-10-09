// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Shared projections used to bootstrap equivalent Bivy nodes on each substrate.

import { clampTtlMinutes } from "./ephemeral-lifecycle.js";
import { PERSISTENT_ROOT, type BootstrapOpts } from "./ephemeral-provider-ports.js";
import { shq } from "./ephemeral-provider-utils.js";

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
 *  optional (repo, hosted-queue opt-in, routing label, GitHub token). */
function bivyBootstrapExports(opts: BootstrapOpts): string[] {
  // Every supported ephemeral provider is a destroy lane. The daemon learns
  // that it is disposable so it can snapshot and end the machine once idle.
  const ephemeral = Boolean(opts.provider);
  const persistent = ephemeral && opts.sleepOnIdle;
  return [
    persistent ? `export BIVY_DATA_DIR=${PERSISTENT_ROOT}/bivy` : "export BIVY_DATA_DIR=/etc/bivy",
    persistent ? `export BIVY_WORKSPACE=${PERSISTENT_ROOT}/workspace` : "",
    persistent ? `export HOME=${PERSISTENT_ROOT}/home` : "",
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
    persistent ? "export BIVY_EPHEMERAL_SLEEP=1" : "",
  ].filter(Boolean);
}

/** `/etc/bivy/start.sh` — exports the runtime env then runs the daemon in the
 *  FOREGROUND (`exec bivy start`). This is the piece that was missing: the
 *  installer only *installs* Bivy, it never starts the node when there's no TTY
 *  (a headless, pre-enrolled machine). Fly runs it as the machine's init
 *  process (a container needs a blocking foreground process or it exits).
 *  PATH is set explicitly because a non-login container shell doesn't source
 *  the rc file the installer appends BIN_DIR to. */
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
 * logs. */
export function bivyBootstrapStatusCommand(opts: BootstrapOpts, phase: "booting" | "installing" | "starting" | "failed"): string {
  return `curl --connect-timeout 2 --max-time 3 -fsS -X POST -H 'content-type: application/json' -H ${shq(`authorization: Bearer ${opts.enrollmentToken}`)} --data ${shq(JSON.stringify({ phase }))} ${shq(`${opts.controlPlaneUrl.replace(/\/$/, "")}/node/bootstrap-status`)} >/dev/null 2>&1 || true`;
}
