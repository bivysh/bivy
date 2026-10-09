// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Fly Machines boot payload for a pre-enrolled Bivy node.
import { b64 } from "../base64.js";
import { bivyBootstrapStatusCommand, bivyRelayJson, bivyStartScript } from "../ephemeral-provider-bootstrap.js";
import { clampTtlMinutes } from "../ephemeral-lifecycle.js";
import { PERSISTENT_ROOT, type BootstrapOpts } from "../ephemeral-provider-ports.js";
import { shq, utf8 } from "../ephemeral-provider-utils.js";

/** Build the Fly Machine `config` fragment (`files` + `init.exec`) that boots a
 *  headless, pre-enrolled Bivy node. A Fly Machine is an OCI image in a
 *  microVM, not a cloud-init VM, so the relay.json + start.sh are written as
 *  `files` and the daemon is launched as a blocking foreground init process.
 *  `raw_value` is base64 per the Machines API; `start.sh` is invoked via
 *  `bash <path>` so it needs no execute bit. */
export function flyInit(opts: BootstrapOpts): {
  files: { guest_path: string; raw_value: string }[];
  init: { exec: string[] };
} {
  const installUrl = opts.installUrl || "https://bivy.sh/install.sh";
  const ttlSeconds = clampTtlMinutes(opts.ttlMinutes) * 60;
  const b64text = (s: string) => b64(utf8.encode(s));
  // A bare `ubuntu:24.04` OCI image ships neither cloud-init NOR curl — so we
  // install curl/ca-certificates ourselves before fetching the installer
  // (otherwise `curl | bash` fails with "curl: command not found"). A runner
  // image with Bivy preinstalled skips this. `set -euo pipefail` makes any step
  // failing abort the whole boot loudly instead of silently limping on to a
  // doomed `bivy start`.
  const initScript = [
    "set -euo pipefail",
    'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin:$PATH"',
    "export DEBIAN_FRONTEND=noninteractive",
    "mkdir -p /etc/bivy /workspace",
    "chmod 700 /etc/bivy",
    "chmod 600 /etc/bivy/relay.json /etc/bivy/start.sh",
    "export BIVY_DATA_DIR=/etc/bivy",
    "export BIVY_WORKSPACE=/workspace",
    // A sleeping machine keeps its state on the volume. relay.json is always
    // replaced: the control plane is the source of truth for enrollment, and a
    // machine recreated onto an existing volume is issued a fresh token.
    ...(opts.sleepOnIdle ? [
      `mkdir -p ${PERSISTENT_ROOT}/bivy ${PERSISTENT_ROOT}/workspace ${PERSISTENT_ROOT}/home`,
      `chmod 700 ${PERSISTENT_ROOT}/bivy`,
      `install -m 600 /etc/bivy/relay.json ${PERSISTENT_ROOT}/bivy/relay.json`,
    ] : []),
    `trap ${shq(bivyBootstrapStatusCommand(opts, "failed"))} ERR`,
    bivyBootstrapStatusCommand(opts, "booting"),
    `if ! command -v bivy >/dev/null 2>&1; then\n${bivyBootstrapStatusCommand(opts, "installing")}\napt-get update -qq\napt-get install -y -qq curl ca-certificates\ncurl --connect-timeout 10 --max-time 120 -fsSL ${shq(installUrl)} | bash\nfi`,
    bivyBootstrapStatusCommand(opts, "starting"),
    "exec bash /etc/bivy/start.sh",
  ].join("\n");
  return {
    files: [
      { guest_path: "/etc/bivy/relay.json", raw_value: b64text(bivyRelayJson(opts)) },
      { guest_path: "/etc/bivy/start.sh", raw_value: b64text(bivyStartScript(opts)) },
    ],
    // Bound the WHOLE awake period, including a hung package manager/installer.
    // Kill the process group if it ignores TERM.
    init: { exec: ["/usr/bin/timeout", "--kill-after=10s", String(ttlSeconds), "/bin/bash", "-c", initScript] },
  };
}
