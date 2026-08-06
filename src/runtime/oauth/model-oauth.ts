// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Bivy-owned OAuth engine for subscription model providers.
//
// Login (authorization-code + PKCE with a local callback server and manual-paste
// fallback, or RFC-8628 device-code) and token refresh are performed here,
// natively, with no dependency on Pi. Verified provider configs live in
// model-oauth-providers.ts. Credentials are persisted through Bivy's own store.
//
// The interaction contract (prompt/notify) is Bivy-owned here too, so the OAuth
// UX layer (server.ts, bivy-login.ts) no longer imports any Pi type.

import http from "node:http";
import { randomBytes } from "node:crypto";
import { createPkce } from "../../integrations/oauth.js";
import { createCredentialVault, type OAuthCredential } from "../credential-store.js";
import { getModelOAuthProvider, type ModelOAuthProvider } from "./model-oauth-providers.js";

// --- Bivy-owned login interaction (same shape Pi used, now ours) -------------

export type AuthPrompt = { signal?: AbortSignal } & (
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
  | { type: "manual_code"; message: string; placeholder?: string }
);

export type AuthEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export interface AuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

interface OAuthTokens {
  access: string;
  refresh: string;
  /** Absolute expiry, epoch ms (skew already applied). */
  expires: number;
  /** Wall-clock epoch ms this set was minted — the monotonic tiebreak used by the
   *  cross-node merge (see credential-store `preferIncomingCredential`). */
  refreshedAt: number;
  accountId?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- HTTP helpers ------------------------------------------------------------

async function postToken(url: string, encoding: "json" | "form", body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers:
      encoding === "json"
        ? { "content-type": "application/json", accept: "application/json" }
        : { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: encoding === "json" ? JSON.stringify(body) : new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Token endpoint returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = (payload.error_description || payload.error || text.slice(0, 200)) as string;
    throw new Error(`OAuth token request failed (${res.status}): ${err}`);
  }
  return payload;
}

/** Decode a JWT and read `claimPath` → `field` (used for OpenAI's chatgpt_account_id). */
function jwtClaim(token: string, claimPath: string, field: string): string | undefined {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const claim = payload[claimPath];
    if (claim && typeof claim === "object") {
      const value = (claim as Record<string, unknown>)[field];
      return typeof value === "string" ? value : undefined;
    }
  } catch {
    // malformed token — treat as no claim
  }
  return undefined;
}

function tokensFrom(
  provider: ModelOAuthProvider,
  payload: Record<string, unknown>,
  prev?: { refresh?: string; accountId?: string },
): OAuthTokens {
  const access = typeof payload.access_token === "string" ? payload.access_token : "";
  if (!access) throw new Error("OAuth token response is missing access_token");
  const rotated = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
  const refresh = rotated || prev?.refresh || "";
  const expiresIn = Number(payload.expires_in) || 3600;
  const now = Date.now();
  const expires = now + expiresIn * 1000 - provider.refreshSkewMs;

  let accountId: string | undefined = prev?.accountId;
  if (provider.accountIdClaim) {
    accountId = jwtClaim(access, provider.accountIdClaim.path, provider.accountIdClaim.field) ?? accountId;
    if (!accountId) throw new Error(`Could not extract account id for "${provider.id}" from the OAuth token`);
  }
  return { access, refresh, expires, refreshedAt: now, ...(accountId ? { accountId } : {}) };
}

// --- Authorization-code flow (browser + callback server + manual paste) ------

function buildAuthorizeUrl(provider: ModelOAuthProvider, opts: { challenge: string; state: string; redirectUri: string }): string {
  const url = new URL(provider.authorizeUrl!);
  for (const [k, v] of Object.entries(provider.authorizeParams ?? {})) url.searchParams.set(k, v);
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", provider.scopes);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", opts.state);
  return url.toString();
}

/** Pull the bare authorization code out of a pasted redirect URL / `code#state` / raw code. */
export function extractAuthCode(value: string): string {
  const v = value.trim();
  if (!v) throw new Error("No authorization code provided");
  if (v.includes("://")) {
    try {
      const code = new URL(v).searchParams.get("code");
      if (code) return code;
    } catch {
      // not a URL after all — fall through
    }
  }
  const hash = v.indexOf("#");
  return hash > 0 ? v.slice(0, hash) : v;
}

function respondHtml(res: http.ServerResponse, status: number, title: string, body: string) {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3rem;max-width:32rem"><h2>${title}</h2><p>${body}</p><p>You can close this tab and return to Bivy.</p></body>`);
}

/** Local HTTP listener that resolves the authorization code from the provider redirect. */
function startCallbackServer(host: string, port: number, pathName: string, expectedState: string, signal?: AbortSignal): { promise: Promise<string>; close: () => void } {
  let server: http.Server | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { server?.close(); } catch { /* ignore */ }
  };
  const promise = new Promise<string>((resolve, reject) => {
    server = http.createServer((req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "", `http://${host}:${port}`);
      } catch {
        res.statusCode = 400;
        res.end("bad request");
        return;
      }
      if (url.pathname !== pathName) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (error) {
        respondHtml(res, 400, "Sign-in failed", `The provider returned: ${error}`);
        close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code) {
        respondHtml(res, 400, "Sign-in failed", "No authorization code in the callback.");
        return;
      }
      if (expectedState && state && state !== expectedState) {
        respondHtml(res, 400, "Sign-in failed", "Authorization state did not match.");
        return;
      }
      respondHtml(res, 200, "Signed in", "Bivy received your authorization.");
      close();
      resolve(code);
    });
    server.on("error", (err) => {
      // e.g. the callback port is busy — the manual-paste path still works.
      close();
      reject(err);
    });
    signal?.addEventListener("abort", () => { close(); reject(new Error("Login aborted")); }, { once: true });
    server.listen(port, host);
  });
  return { promise, close };
}

async function loginAuthCode(provider: ModelOAuthProvider, interaction: AuthInteraction): Promise<OAuthTokens> {
  const { verifier, challenge } = createPkce();
  const state = provider.stateIsVerifier ? verifier : randomBytes(16).toString("hex");
  const redirectUri = `http://${provider.callback!.redirectHost}:${provider.callback!.port}${provider.callback!.path}`;
  const authorizeUrl = buildAuthorizeUrl(provider, { challenge, state, redirectUri });

  interaction.notify({
    type: "auth_url",
    url: authorizeUrl,
    instructions: "Sign in in your browser. If it doesn't return automatically, paste the redirect URL (or the code) back here.",
  });

  const bindHost = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
  const sources: Promise<string>[] = [];
  const closers: Array<() => void> = [];
  if (provider.callback) {
    const server = startCallbackServer(bindHost, provider.callback.port, provider.callback.path, state, interaction.signal);
    closers.push(server.close);
    sources.push(server.promise);
  }
  sources.push(interaction.prompt({ type: "manual_code", message: "Paste the redirect URL or authorization code:", signal: interaction.signal }));

  let raw: string;
  try {
    raw = await Promise.any(sources);
  } catch (error) {
    // Every source failed (callback error + paste rejected/cancelled).
    if (error instanceof AggregateError) {
      const last = error.errors[error.errors.length - 1];
      throw last instanceof Error ? last : new Error("Sign-in did not complete");
    }
    throw error;
  } finally {
    for (const close of closers) close();
  }

  const code = extractAuthCode(raw);
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: provider.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  };
  if (provider.tokenEncoding === "json") body.state = state; // Anthropic includes state
  const payload = await postToken(provider.tokenUrl, provider.tokenEncoding, body);
  return tokensFrom(provider, payload);
}

// --- Device-code flow (RFC 8628) ---------------------------------------------

async function loginDeviceCode(provider: ModelOAuthProvider, interaction: AuthInteraction): Promise<OAuthTokens> {
  const start = await postToken(provider.deviceAuthUrl!, "form", {
    client_id: provider.clientId,
    scope: provider.scopes,
    ...(provider.deviceParams ?? {}),
  });
  const deviceCode = String(start.device_code ?? "");
  const userCode = String(start.user_code ?? "");
  const verificationUri = String(start.verification_uri_complete ?? start.verification_uri ?? "");
  let interval = (Number(start.interval) || 5) * 1000;
  const deadline = Date.now() + (Number(start.expires_in) || 900) * 1000;
  if (!deviceCode || !userCode) throw new Error("Device authorization did not return a device/user code");

  interaction.notify({
    type: "device_code",
    userCode,
    verificationUri,
    intervalSeconds: Number(start.interval) || 5,
    expiresInSeconds: Number(start.expires_in) || undefined,
  });

  // Providers that use device-code sleep one interval before the first poll.
  await sleep(interval);
  for (;;) {
    if (interaction.signal?.aborted) throw new Error("Login aborted");
    if (Date.now() > deadline) throw new Error("Device login timed out. Please try again.");
    let payload: Record<string, unknown>;
    try {
      payload = await postToken(provider.tokenUrl, "form", {
        grant_type: provider.deviceGrantType ?? "urn:ietf:params:oauth:grant-type:device_code",
        client_id: provider.clientId,
        device_code: deviceCode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/authorization_pending/i.test(message)) {
        await sleep(interval);
        continue;
      }
      if (/slow_down/i.test(message)) {
        interval += 5000;
        await sleep(interval);
        continue;
      }
      throw error; // access_denied / expired_token / other
    }
    return tokensFrom(provider, payload);
  }
}

// --- Public API --------------------------------------------------------------

/** Provider ids Bivy can natively drive a subscription login for. */
export { isNativeOAuthProvider, nativeOAuthProviderIds } from "./model-oauth-providers.js";

/**
 * Run a provider's OAuth login natively and persist the credential into Bivy's
 * store. The interaction (prompt/notify) is caller-supplied; the whole flow —
 * PKCE, callback server, token exchange — is Bivy's.
 */
export async function loginModelOAuth(credsDir: string, providerId: string, interaction: AuthInteraction): Promise<void> {
  const provider = getModelOAuthProvider(providerId);
  if (!provider) throw new Error(`Provider "${providerId}" does not support subscription login`);
  const tokens = provider.flow === "device_code" ? await loginDeviceCode(provider, interaction) : await loginAuthCode(provider, interaction);
  const credential: OAuthCredential = { type: "oauth", access: tokens.access, refresh: tokens.refresh, expires: tokens.expires, refreshedAt: tokens.refreshedAt, ...(tokens.accountId ? { accountId: tokens.accountId } : {}) };
  await createCredentialVault(credsDir).modify(providerId, async () => credential);
}

/** Exchange the refresh token for a fresh credential (network call; throws on failure). */
async function refreshTokens(provider: ModelOAuthProvider, current: OAuthCredential): Promise<OAuthTokens> {
  const refresh = typeof current.refresh === "string" ? current.refresh : "";
  if (!refresh) throw new Error(`No refresh token stored for "${provider.id}"`);
  const payload = await postToken(provider.tokenUrl, provider.tokenEncoding, {
    grant_type: "refresh_token",
    client_id: provider.clientId,
    refresh_token: refresh,
  });
  return tokensFrom(provider, payload, {
    refresh: provider.refreshRotates ? undefined : refresh,
    accountId: typeof current.accountId === "string" ? current.accountId : undefined,
  });
}

/**
 * Ensure a fresh OAuth access token for a provider and return it. The refresh
 * runs inside the store's per-provider lock, and re-checks expiry there, so
 * concurrent callers (and other processes) can't double-spend a rotating refresh
 * token — the single-flight guarantee. Returns undefined if the provider has no
 * stored OAuth credential or isn't natively supported.
 */
export async function refreshModelOAuth(credsDir: string, providerId: string): Promise<string | undefined> {
  const provider = getModelOAuthProvider(providerId);
  if (!provider) return undefined;
  const result = await createCredentialVault(credsDir).modify(providerId, async (current) => {
    if (!current || current.type !== "oauth") return current;
    // Someone else already refreshed while we waited for the lock — use theirs.
    if (Number(current.expires) > Date.now()) return current;
    const fresh = await refreshTokens(provider, current);
    return { type: "oauth", access: fresh.access, refresh: fresh.refresh, expires: fresh.expires, refreshedAt: fresh.refreshedAt, ...(fresh.accountId ? { accountId: fresh.accountId } : {}) };
  });
  return result?.type === "oauth" ? result.access : undefined;
}
