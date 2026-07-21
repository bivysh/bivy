// SPDX-License-Identifier: FSL-1.1-ALv2
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

/** Perform one allowlisted provider request for a remote device. Rejects any non-provider host. */
export async function execEphemeralRequest(
  request: EphemeralExecRequest | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<EphemeralExecResult> {
  const url = String(request?.url ?? "");
  let host: string;
  try { host = new URL(url).host; } catch { throw new Error(`Bad provider URL: ${url}`); }
  if (!EPHEMERAL_ALLOWED_HOSTS.has(host)) throw new Error(`Refusing to proxy to non-provider host: ${host}`);

  const method = String(request?.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { ...(request?.headers ?? {}) };
  let payload: string | undefined;
  if (request?.body !== undefined && request?.body !== null && method !== "GET" && method !== "HEAD") {
    payload = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetchImpl(url, { method, headers, body: payload, signal: controller.signal });
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON provider response */ }
    return { status: res.status, body };
  } finally {
    clearTimeout(timeout);
  }
}
