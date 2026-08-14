// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Ephemeral provisioning proxy (node-broker path).
//
// A remote device that holds the user's cloud token asks this node to make ONE
// allowlisted HTTPS request to a provider (Fly/Hetzner/AWS/...) on its behalf —
// the browser can't call those APIs directly (no CORS). The token/credentials
// ride in the request headers and are used transiently; nothing is persisted
// here, so the provisioning stays end-to-end (the control plane never sees
// it). The host allowlist is the SSRF guard and must be kept in lock-step with
// the two other copies: `ALLOWED_HOSTS` in packages/core/src/ephemeral.ts
// (the browser-side adapter) and the control-plane's cold-start relay in
// services/control-plane/src/index.ts.

export const EPHEMERAL_ALLOWED_HOSTS = new Set([
  "api.hetzner.cloud",
  "api.machines.dev",
  "api.fly.io",
  "api.sprites.dev",
  "api.e2b.app",
  "ec2.us-east-1.amazonaws.com",
  "ec2.us-west-2.amazonaws.com",
  "ec2.eu-west-1.amazonaws.com",
  "ec2.eu-central-1.amazonaws.com",
  "ec2.ap-southeast-1.amazonaws.com",
  "ec2.ap-northeast-1.amazonaws.com",
  "ssm.us-east-1.amazonaws.com",
  "ssm.us-west-2.amazonaws.com",
  "ssm.eu-west-1.amazonaws.com",
  "ssm.eu-central-1.amazonaws.com",
  "ssm.ap-southeast-1.amazonaws.com",
  "ssm.ap-northeast-1.amazonaws.com",
]);

export interface EphemeralExecRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface EphemeralExecResult {
  status: number;
  body: unknown;
}

/** Hard cap on redirect hops, so a provider (or a MITM) can't wedge us in a loop. */
const MAX_REDIRECTS = 5;

function checkAllowedHost(url: string): string {
  let host: string;
  try { host = new URL(url).host; } catch { throw new Error(`Bad provider URL: ${url}`); }
  if (!EPHEMERAL_ALLOWED_HOSTS.has(host)) throw new Error(`Refusing to proxy to non-provider host: ${host}`);
  return host;
}

/**
 * How a redirect changes the follow-up request, mirroring the WHATWG fetch spec's
 * own `redirect: "follow"` behavior (which we're replicating manually below so we
 * can re-validate the target host on every hop): 303 always downgrades to a
 * bodyless GET; 301/302 do the same but only for a non-GET/HEAD method; 307/308
 * preserve the original method and body.
 */
function nextHopRequest(status: number, method: string, payload: string | undefined): { method: string; payload: string | undefined } {
  if (status === 303 || ((status === 301 || status === 302) && method !== "GET" && method !== "HEAD")) {
    return { method: "GET", payload: undefined };
  }
  return { method, payload };
}

/**
 * Perform one allowlisted provider request for a remote device. Rejects any
 * non-provider host — including a redirect target: the allowlist check ran only
 * on the *initial* URL, but a plain `fetch` follows redirects transparently, so a
 * provider response (or anyone able to influence it) could 302 us — Authorization
 * header and all — to an arbitrary host. `redirect: "manual"` disables that
 * auto-follow so every hop's Location is re-checked against the same allowlist
 * before it's requested.
 */
export async function execEphemeralRequest(
  request: EphemeralExecRequest | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<EphemeralExecResult> {
  let url = String(request?.url ?? "");
  let method = String(request?.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { ...(request?.headers ?? {}) };
  let payload: string | undefined;
  if (request?.body !== undefined && request?.body !== null && method !== "GET" && method !== "HEAD") {
    payload = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    for (let hop = 0; ; hop++) {
      const host = checkAllowedHost(url);
      const res = await fetchImpl(url, { method, headers, body: payload, signal: controller.signal, redirect: "manual" });

      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects proxying to ${host}`);
        const location = res.headers.get("location");
        if (!location) throw new Error(`Redirect from ${host} (${res.status}) had no Location header`);
        // Resolve relative to the current hop; the loop's next iteration
        // re-validates this new host before it's ever requested — the whole
        // point of this loop.
        url = new URL(location, url).toString();
        ({ method, payload } = nextHopRequest(res.status, method, payload));
        continue;
      }

      const text = await res.text();
      let body: unknown = text;
      try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON provider response */ }
      return { status: res.status, body };
    }
  } finally {
    clearTimeout(timeout);
  }
}
