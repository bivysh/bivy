// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Pure helpers for `bivy tailscale`: read `tailscale status --json` and
// `tailscale serve status --json`, and build the `tailscale serve` arguments.
// No process spawning here, so each decision is testable on its own.

/** The one HTTPS port Bivy claims on the machine's tailnet name. */
export const SERVE_HTTPS_PORT = 443;

/** `{ running, hostname }` from `tailscale status --json` output. */
export function parseTailscaleStatus(text) {
  let status;
  try { status = JSON.parse(text); } catch { return { running: false, hostname: null }; }
  const hostname = String(status?.Self?.DNSName ?? "").replace(/\.$/, "") || null;
  return { running: status?.BackendState === "Running", hostname };
}

/** Where `tailscale serve` should send the machine's HTTPS traffic. */
export function serveTarget(port) {
  return `http://127.0.0.1:${port}`;
}

export function serveOnArgs(port) {
  return ["serve", "--bg", `--https=${SERVE_HTTPS_PORT}`, serveTarget(port)];
}

export function serveOffArgs() {
  return ["serve", `--https=${SERVE_HTTPS_PORT}`, "off"];
}

/**
 * What already sits on `<hostname>:443`, from `tailscale serve status --json`:
 * `funnel` when it is public (Tailscale Funnel), and the proxy target of `/`
 * when something is served there. Bivy refuses to share a Funnel'd name, and
 * refuses to replace a target that isn't its own.
 */
export function serveState(text, hostname) {
  let status;
  try { status = JSON.parse(text || "{}"); } catch { status = {}; }
  const key = `${hostname}:${SERVE_HTTPS_PORT}`;
  const handlers = status?.Web?.[key]?.Handlers ?? {};
  return {
    funnel: status?.AllowFunnel?.[key] === true,
    target: typeof handlers["/"]?.Proxy === "string" ? handlers["/"].Proxy : null,
    otherPaths: Object.keys(handlers).filter((p) => p !== "/"),
  };
}

/** Why `bivy tailscale` can't take `<hostname>:443`, or null when it can. */
export function serveConflict(state, port) {
  if (state.funnel) return "Tailscale Funnel is on for this machine's HTTPS name, which would put Bivy on the public internet. Turn it off first: tailscale funnel reset";
  if (state.target && state.target !== serveTarget(port)) return `tailscale serve already sends https:// on this machine to ${state.target}. Remove it first: tailscale serve --https=${SERVE_HTTPS_PORT} off`;
  if (state.otherPaths.length) return `tailscale serve already has paths on this machine's HTTPS name (${state.otherPaths.join(", ")}). Remove them first: tailscale serve --https=${SERVE_HTTPS_PORT} off`;
  return null;
}

/** A one-line hint for a failed `tailscale serve`, from its stderr. */
export function serveFailureHint(stderr) {
  const text = String(stderr ?? "");
  if (/access denied|permission denied|must be root|operator/i.test(text)) return "Let your user manage Tailscale once: sudo tailscale set --operator=$USER";
  if (/https.*not enabled|enable https|certificates/i.test(text)) return "Turn on HTTPS certificates for your tailnet (admin console → DNS → HTTPS Certificates), then run this again.";
  return null;
}
