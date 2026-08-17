// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Verified OAuth configs for Bivy-owned subscription providers.
//
// Every value here is ported VERBATIM from the shipped @earendil-works/pi-ai
// source (auth/oauth/*.js in 0.80.9) — real, verified client ids and endpoints,
// not guesses. Owning these lets Bivy run the OAuth login + token refresh itself,
// so no credential operation depends on Pi.
//
// Covered (fully Bivy-owned): Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT),
// xAI (Grok). GitHub Copilot (two-stage token + dynamic base URL entangled with
// Pi's request layer) and Radius (self-describing gateway) are intentionally not
// reimplemented here.

export type ModelOAuthFlow = "auth_code" | "device_code";
export type TokenEncoding = "json" | "form";

export interface ModelOAuthProvider {
  id: string;
  /** Subscription-login label shown in the picker. */
  displayName: string;
  clientId: string;
  scopes: string;
  flow: ModelOAuthFlow;
  tokenEncoding: TokenEncoding;
  /** Token endpoint — code exchange + refresh. */
  tokenUrl: string;
  /** Authorize endpoint (auth_code flow). */
  authorizeUrl?: string;
  /** Local callback listener (auth_code flow). `redirectHost` is what goes into
   *  the redirect_uri sent to the provider (may differ from the bind host). */
  callback?: { port: number; path: string; redirectHost: string };
  /** Device-authorization endpoint (device_code flow). */
  deviceAuthUrl?: string;
  /** Extra params appended to the authorize URL. */
  authorizeParams?: Record<string, string>;
  /** `state` sent to authorize equals the PKCE verifier (Anthropic). */
  stateIsVerifier?: boolean;
  /** Extra params on the device-authorization request (form). */
  deviceParams?: Record<string, string>;
  /** grant_type used when polling the device flow. */
  deviceGrantType?: string;
  /** Subtract from expiry so tokens refresh a little early. */
  refreshSkewMs: number;
  /** Provider rotates the refresh token on every grant. */
  refreshRotates: boolean;
  /** Access token is a JWT; extract an account id from this claim → subclaim. */
  accountIdClaim?: { path: string; field: string };
}

/** Anthropic uses a JSON token body; OpenAI/xAI use form-encoded. */
export const MODEL_OAUTH_PROVIDERS: Record<string, ModelOAuthProvider> = {
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic (Claude Pro/Max)",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    scopes: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    flow: "auth_code",
    tokenEncoding: "json",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    callback: { port: 53692, path: "/callback", redirectHost: "localhost" },
    authorizeParams: { code: "true" },
    stateIsVerifier: true,
    refreshSkewMs: 5 * 60 * 1000,
    refreshRotates: true,
  },
  "openai-codex": {
    id: "openai-codex",
    displayName: "OpenAI (ChatGPT Plus/Pro)",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    scopes: "openid profile email offline_access",
    flow: "auth_code",
    tokenEncoding: "form",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    callback: { port: 1455, path: "/auth/callback", redirectHost: "localhost" },
    authorizeParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "pi",
    },
    // Refresh a little early (like Anthropic/xAI) so Codex never bakes an
    // already-expired access token into ~/.codex/auth.json and 401s mid-turn.
    refreshSkewMs: 5 * 60 * 1000,
    refreshRotates: true,
    accountIdClaim: { path: "https://api.openai.com/auth", field: "chatgpt_account_id" },
  },
  xai: {
    id: "xai",
    displayName: "xAI (Grok / X subscription)",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    scopes: "openid profile email offline_access grok-cli:access api:access",
    flow: "device_code",
    tokenEncoding: "form",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    deviceAuthUrl: "https://auth.x.ai/oauth2/device/code",
    deviceParams: { referrer: "pi" },
    deviceGrantType: "urn:ietf:params:oauth:grant-type:device_code",
    refreshSkewMs: 5 * 60 * 1000,
    refreshRotates: false,
  },
};

/** Provider ids Bivy can natively drive an OAuth subscription login/refresh for. */
export function nativeOAuthProviderIds(): string[] {
  return Object.keys(MODEL_OAUTH_PROVIDERS);
}

/** Whether Bivy owns OAuth for this provider (vs. it being api-key or unsupported). */
export function isNativeOAuthProvider(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODEL_OAUTH_PROVIDERS, id.trim().toLowerCase());
}

export function getModelOAuthProvider(id: string): ModelOAuthProvider | undefined {
  return MODEL_OAUTH_PROVIDERS[id.trim().toLowerCase()];
}
