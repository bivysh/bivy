// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
/**
 * GitHub OAuth Device Flow for STAGED repo scope (C3).
 *
 * At sign-in the control plane asks GitHub for only `read:user user:email`
 * (minimal scope — see services/control-plane C1). The broader `repo` scope
 * (push branches, open PRs) is requested LATER and only when the user actually
 * connects a repo to the work queue.
 *
 * Crucially this runs on the NODE and talks straight to GitHub's device-flow
 * endpoints — the control plane is never in the loop, so it never sees the
 * repo-scoped token (invariant #3: the control plane stores metadata only). The
 * node keeps the token in its own config and uses it for issue→PR work.
 *
 * Device flow uses a PUBLIC client id (no client secret), which is exactly the
 * right shape for an app the user installs. Set BIVY_GITHUB_OAUTH_CLIENT_ID to
 * the OAuth app that has "Device flow" enabled.
 */

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSec: number;
  expiresInSec: number;
}

export interface DeviceFlowCallbacks {
  /** Show the user the code + URL to authorize in their browser. */
  onPrompt: (info: { userCode: string; verificationUri: string }) => void;
  /** Optional: open the verification URL automatically. */
  openBrowser?: (url: string) => void;
  signal?: AbortSignal;
}

/** Default repo-connect scope: branch push + PRs + issue read/write. */
export const REPO_CONNECT_SCOPE = "repo";

/** Resolve the device-flow client id (public). Returns undefined if unset. */
export function deviceFlowClientId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.BIVY_GITHUB_OAUTH_CLIENT_ID?.trim() || undefined;
}

/** Step 1: ask GitHub for a device + user code. */
export async function requestDeviceCode(clientId: string, scope = REPO_CONNECT_SCOPE): Promise<DeviceCode> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope }),
  });
  if (!res.ok) throw new Error(`GitHub device-code request failed (${res.status})`);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!data.device_code || !data.user_code) throw new Error("GitHub returned no device code (is device flow enabled on the OAuth app?)");
  return {
    deviceCode: String(data.device_code),
    userCode: String(data.user_code),
    verificationUri: String(data.verification_uri ?? "https://github.com/login/device"),
    intervalSec: Math.max(Number(data.interval) || 5, 1),
    expiresInSec: Number(data.expires_in) || 900,
  };
}

export type TokenPoll =
  | { status: "ok"; token: string }
  | { status: "pending" }
  | { status: "slow_down"; intervalSec?: number }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; error: string };

/**
 * Interpret a GitHub access-token poll response. Pure, so the (otherwise
 * timing-dependent) state machine is unit-testable.
 */
export function interpretTokenResponse(data: Record<string, unknown>): TokenPoll {
  if (typeof data.access_token === "string" && data.access_token) {
    return { status: "ok", token: data.access_token };
  }
  switch (data.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down", intervalSec: Number(data.interval) || undefined };
    case "access_denied":
      return { status: "denied" };
    case "expired_token":
      return { status: "expired" };
    default:
      return { status: "error", error: String(data.error_description ?? data.error ?? "unknown error") };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Step 2: poll until the user authorizes (or the code expires). */
export async function pollForAccessToken(clientId: string, device: DeviceCode, signal?: AbortSignal): Promise<string> {
  let intervalMs = device.intervalSec * 1000;
  const deadline = Date.now() + device.expiresInSec * 1000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Cancelled");
    await sleep(intervalMs);
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId, device_code: device.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const poll = interpretTokenResponse(data);
    if (poll.status === "ok") return poll.token;
    if (poll.status === "slow_down") intervalMs += (poll.intervalSec ? poll.intervalSec * 1000 : 5000);
    else if (poll.status === "denied") throw new Error("Authorization was denied.");
    else if (poll.status === "expired") throw new Error("The code expired before authorization. Try again.");
    else if (poll.status === "error") throw new Error(`GitHub authorization failed: ${poll.error}`);
    // "pending": keep polling.
  }
  throw new Error("Timed out waiting for GitHub authorization.");
}

/**
 * Full staged-scope connect: request a device code, prompt the user, and return
 * the repo-scoped token. The caller persists it in the node's own config.
 */
export async function connectRepoScope(clientId: string, cb: DeviceFlowCallbacks): Promise<string> {
  const device = await requestDeviceCode(clientId, REPO_CONNECT_SCOPE);
  cb.openBrowser?.(device.verificationUri);
  cb.onPrompt({ userCode: device.userCode, verificationUri: device.verificationUri });
  return pollForAccessToken(clientId, device, cb.signal);
}
