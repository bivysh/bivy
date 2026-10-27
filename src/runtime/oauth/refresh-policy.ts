// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Whether this machine may refresh subscription sign-ins. Anthropic and OpenAI
 * rotate the refresh token on every grant, so two machines refreshing copies of
 * one login lock each other out. A runner (`BIVY_OAUTH_REFRESH=0`, set by its
 * boot payload) uses the access tokens it was given and never spends the
 * refresh token: the login stays with the machine that owns it.
 */
export function oauthRefreshAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BIVY_OAUTH_REFRESH !== "0";
}
