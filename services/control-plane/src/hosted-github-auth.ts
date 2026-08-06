// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Minting short-lived GitHub App installation tokens for hosted provisioning.
// Preferred over a stored long-lived PAT: an installation token is ~1h,
// repo-scoped, and minted on demand, so a compromised machine (or database)
// yields at most a short-lived, narrowly-scoped credential — and long agent
// sessions keep working because the machine re-fetches a fresh token per git
// operation from the mint-on-demand endpoint.
//
// The app private key is held (encrypted) on the control plane only for the
// hosted path; see docs/hosted-provisioning-trust-model.md.
import { createSign } from "node:crypto";

export interface GithubAppCreds {
  appId: string;
  installationId: string;
  privateKeyPem: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RS256 app JWT: iat backdated 30s for clock skew, 9-minute expiry (< GitHub's 10m cap). */
export function createAppJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSec - 30, exp: nowSec + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = b64url(signer.sign(privateKeyPem));
  return `${signingInput}.${signature}`;
}

/** Exchange the app JWT for a ~1h installation access token. */
export async function mintInstallationToken(
  creds: GithubAppCreds,
  fetchImpl: typeof fetch = fetch,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<InstallationToken> {
  const jwt = createAppJwt(creds.appId, creds.privateKeyPem, nowSec);
  const res = await fetchImpl(`https://api.github.com/app/installations/${encodeURIComponent(creds.installationId)}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "bivy-control-plane",
    },
  });
  const data = (await res.json().catch(() => ({}))) as { token?: string; expires_at?: string; message?: string };
  if (!res.ok || !data.token) {
    throw new Error(`GitHub installation-token mint failed (${res.status}): ${data.message ?? "unknown error"}`);
  }
  return { token: data.token, expiresAt: data.expires_at ?? "" };
}
