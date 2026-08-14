// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { createHash, randomBytes } from "node:crypto";
import type { IntegrationAuthSpec } from "./types.js";

type OAuth2Spec = Extract<IntegrationAuthSpec, { kind: "oauth2" }>;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
}

function base64url(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(
  spec: OAuth2Spec,
  opts: { clientId: string; redirectUri: string; state: string; codeChallenge?: string },
): string {
  const url = new URL(spec.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  if (spec.scopes.length) url.searchParams.set("scope", spec.scopes.join(" "));
  if (opts.codeChallenge) {
    url.searchParams.set("code_challenge", opts.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(spec.extraAuthParams ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

function normalizeToken(payload: any): TokenSet {
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken: String(payload.access_token),
    refreshToken: payload.refresh_token ? String(payload.refresh_token) : undefined,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    scope: payload.scope ? String(payload.scope) : undefined,
    tokenType: payload.token_type ? String(payload.token_type) : "Bearer",
  };
}

async function postToken(spec: OAuth2Spec, body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(spec.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Token endpoint returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || !payload.access_token) {
    throw new Error(`Token exchange failed (${res.status}): ${payload.error_description || payload.error || text.slice(0, 200)}`);
  }
  return normalizeToken(payload);
}

export function exchangeCode(
  spec: OAuth2Spec,
  client: OAuthClient,
  opts: { code: string; redirectUri: string; codeVerifier?: string },
): Promise<TokenSet> {
  return postToken(spec, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    ...(opts.codeVerifier ? { code_verifier: opts.codeVerifier } : {}),
  });
}

export async function refreshToken(spec: OAuth2Spec, client: OAuthClient, refresh: string): Promise<TokenSet> {
  const next = await postToken(spec, {
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  // Providers often omit the refresh_token on refresh; keep the existing one.
  if (!next.refreshToken) next.refreshToken = refresh;
  return next;
}
