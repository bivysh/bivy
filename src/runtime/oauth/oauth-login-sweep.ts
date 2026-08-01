// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
//
// Pure decision for sweeping stale browser-initiated OAuth logins (see the
// `oauthLogins` registry in src/server.ts). A login parks the node until the
// remote device pastes its code; an abandoned one must be reaped (aborting it
// closes the local callback http.Server) and a finished one dropped after a
// short grace so clients can still read its final status. Kept pure + isolated
// so the edge logic is unit-tested without importing the daemon.

export type OAuthLoginStatus = "starting" | "waiting" | "done" | "error";

export interface OAuthSweepOptions {
  /** Reap an in-flight (starting/waiting) login older than this. */
  ttlMs: number;
  /** Drop a finished (done/error) login older than this. */
  graceMs: number;
}

export interface OAuthSweepDecision {
  /** Remove the entry from the registry. */
  drop: boolean;
  /** Abort the login first (only for a still-in-flight one) to close its
   *  callback server and reject the parked manual-code promise. */
  abort: boolean;
}

export function isTerminalOAuthStatus(status: OAuthLoginStatus): boolean {
  return status === "done" || status === "error";
}

export function decideOAuthLoginSweep(
  status: OAuthLoginStatus,
  ageMs: number,
  opts: OAuthSweepOptions,
): OAuthSweepDecision {
  const terminal = isTerminalOAuthStatus(status);
  const expired = terminal ? ageMs > opts.graceMs : ageMs > opts.ttlMs;
  if (!expired) return { drop: false, abort: false };
  return { drop: true, abort: !terminal };
}
