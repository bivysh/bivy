// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { createSign } from "node:crypto";
import { resolveSecret } from "./secrets.js";

/**
 * GitHub App installation tokens (M2, flavor A: user-owned app, key on the node).
 *
 * The node holds the app private key and mints its own short-lived installation
 * access tokens — the control plane never sees a repo-capable credential. A JWT
 * signed with the app key is exchanged for a 1h installation token scoped to the
 * repos the app is installed on; comments/PRs then post as `<app>[bot]`.
 *
 * Dependency-free (node:crypto only), matching the rest of the webhook path.
 */

const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

/**
 * Build a short-lived GitHub App JWT (RS256). `iat` is backdated 30s to tolerate
 * clock skew; `exp` is 9 min out (GitHub's ceiling is 10). `iss` is the app id.
 */
export function createAppJwt(appId: string | number, privateKeyPem: string, nowSec: number): string {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSec - 30, exp: nowSec + 540, iss: String(appId) };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).end().sign(privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

type FetchLike = typeof fetch;

export interface AppTokenResult {
  token: string;
  expiresAt: string; // ISO8601 from GitHub, or "" if absent
}

/** Exchange an app JWT for a 1h installation access token. */
export async function mintInstallationToken(opts: {
  appId: string | number;
  privateKeyPem: string;
  installationId: string | number;
  nowSec?: number;
  fetchImpl?: FetchLike;
}): Promise<AppTokenResult> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const jwt = createAppJwt(opts.appId, opts.privateKeyPem, nowSec);
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`https://api.github.com/app/installations/${opts.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "bivy",
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub installation token request failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await res.json().catch(() => ({}))) as { token?: string; expires_at?: string };
  if (!data.token) throw new Error("GitHub installation token response had no token");
  return { token: data.token, expiresAt: data.expires_at ?? "" };
}

/**
 * Resolve the installation id for a repo the app is installed on, via
 * `GET /repos/{owner}/{repo}/installation` (authed with an app JWT — no
 * installation token needed yet, which is the chicken/egg this breaks). Returns
 * undefined when the app isn't installed there (404) or on any API error, so the
 * caller falls back to the user PAT. `owner`/`repo` are expected pre-validated.
 */
export async function resolveInstallationId(opts: {
  appId: string | number;
  privateKeyPem: string;
  owner: string;
  repo: string;
  nowSec?: number;
  fetchImpl?: FetchLike;
}): Promise<string | undefined> {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const jwt = createAppJwt(opts.appId, opts.privateKeyPem, nowSec);
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`https://api.github.com/repos/${opts.owner}/${opts.repo}/installation`, {
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "bivy",
    },
  });
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => ({}))) as { id?: number | string };
  return data.id != null ? String(data.id) : undefined;
}

/**
 * Per-installation token cache. Reuses a token until ~5 min before it expires,
 * so one webhook burst doesn't mint a token per work item. Injectable fetch/clock
 * for tests.
 */
export class InstallationTokenCache {
  private cache = new Map<string, AppTokenResult>();
  private static readonly SKEW_MS = 5 * 60 * 1000;

  constructor(
    private readonly appId: string,
    private readonly privateKeyPem: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(installationId: string | number): Promise<string> {
    const key = String(installationId);
    const hit = this.cache.get(key);
    if (hit?.expiresAt && Date.parse(hit.expiresAt) - this.now() > InstallationTokenCache.SKEW_MS) {
      return hit.token;
    }
    const fresh = await mintInstallationToken({
      appId: this.appId,
      privateKeyPem: this.privateKeyPem,
      installationId,
      nowSec: Math.floor(this.now() / 1000),
      fetchImpl: this.fetchImpl,
    });
    this.cache.set(key, fresh);
    return fresh.token;
  }
}

export interface GitHubAppConfig {
  appId: string;
  privateKeyPem: string;
}

/**
 * Load the node's user-owned GitHub App credentials from env + vault:
 *   BIVY_GITHUB_APP_ID           — the app id
 *   BIVY_GITHUB_APP_PRIVATE_KEY  — a secret:// ref (default secret://github.app-private-key)
 *                                  or an inline PEM.
 * Returns undefined when no app is configured (node falls back to the PAT path).
 */
export async function loadGitHubAppConfig(env: NodeJS.ProcessEnv = process.env): Promise<GitHubAppConfig | undefined> {
  const appId = env.BIVY_GITHUB_APP_ID?.trim();
  if (!appId) return undefined;
  const ref = env.BIVY_GITHUB_APP_PRIVATE_KEY?.trim() || "secret://github.app-private-key";
  const privateKeyPem =
    ref.startsWith("secret://") || ref.startsWith("op://") || ref.startsWith("env://")
      ? await resolveSecret(ref)
      : ref;
  if (!privateKeyPem) return undefined;
  return { appId, privateKeyPem };
}
