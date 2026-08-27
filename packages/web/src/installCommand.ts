// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The "connect a machine" command the app tells users to paste. On the hosted
// control plane that is the one-line installer; a self-hosted control plane has
// no `install.sh` of its own, so the copied command must instead point `bivy
// setup` at *this* deployment (BIVY_CONTROL_PLANE_URL / BIVY_RELAY_URL are the
// env vars the setup wizard pre-fills from) — otherwise a self-hoster's node
// would enroll on app.bivy.sh. When the app is already signed in, include the
// current account session as BIVY_SESSION_TOKEN so `bivy setup` can enroll the
// new Machine without asking the user to authenticate again. Also expose a plain
// no-token variant for users who prefer to authenticate on the new Machine.
// Pure so it's testable without a DOM.

/** The one-line installer, hosted control plane only. */
export const HOSTED_INSTALL_CMD = "curl -fsSL https://bivy.sh/install.sh | bash";

/** Whether an origin is the hosted control plane (or one of its environments). */
export function isHostedControlPlane(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "bivy.sh" || host.endsWith(".bivy.sh");
  } catch {
    return false;
  }
}

export interface InstallCommand {
  /** Preferred shell command to copy; includes a session token when one is available. */
  command: string;
  /** Same install path, but without the current account session token. */
  plainCommand: string;
  /** True on the hosted control plane, where `/install.sh` is also downloadable. */
  hosted: boolean;
  /** True when `command` carries the current account session for no-repeat sign-in. */
  authenticated: boolean;
}

/**
 * Build the connect-a-machine command for the control plane at `origin`.
 * `relayUrl` (the relay this client was told to use, if known) is included so
 * the node dials the same relay without a prompt.
 */
export function installCommand(origin: string, relayUrl?: string | null, sessionToken?: string | null): InstallCommand {
  const cp = origin.replace(/\/$/, "");
  const relay = relayUrl?.replace(/\/$/, "");
  const baseEnv = [
    `BIVY_CONTROL_PLANE_URL=${shellQuote(cp)}`,
    ...(relay ? [`BIVY_RELAY_URL=${shellQuote(relay)}`] : []),
  ];
  const authedEnv = sessionToken ? [`BIVY_SESSION_TOKEN=${shellQuote(sessionToken)}`, ...baseEnv] : baseEnv;
  const hosted = isHostedControlPlane(origin);
  const buildHosted = (env: string[]) => env.length ? `curl -fsSL https://bivy.sh/install.sh | ${env.join(" ")} bash` : HOSTED_INSTALL_CMD;
  const buildSelfHosted = (env: string[]) => `npm install -g @bivy/bivy && ${env.join(" ")} bivy setup`;

  // Put env on the `bash` side of the pipe. `VAR=… curl … | bash` would only
  // scope it to curl, so setup would still prompt for sign-in.
  const plainCommand = hosted ? HOSTED_INSTALL_CMD : buildSelfHosted(baseEnv);
  return {
    command: sessionToken ? (hosted ? buildHosted(authedEnv) : buildSelfHosted(authedEnv)) : plainCommand,
    plainCommand,
    hosted,
    authenticated: Boolean(sessionToken),
  };
}

/** Quote a value for a POSIX shell only when it needs it (URLs rarely do). */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_.:/=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
