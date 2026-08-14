// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { getModelOAuthProvider } from "./model-oauth-providers.js";

export interface OpenableOAuthLogin {
  provider: string;
  status: string;
  authUrl?: string;
}

export type OAuthNodeOpenResult = { opened: true } | { opened: false; error: string };

/**
 * Open only the provider authorization URL generated for an active ceremony.
 * The URL is checked against Bivy's owned provider registry before reaching the
 * injected desktop opener, so this can never become an arbitrary remote-URL API.
 */
export function openOAuthLoginOnNode(
  login: OpenableOAuthLogin | undefined,
  opener: (url: string) => boolean,
): OAuthNodeOpenResult {
  if (!login?.authUrl || login.status !== "waiting") return { opened: false, error: "Login is no longer waiting for authorization." };
  const provider = getModelOAuthProvider(login.provider);
  if (!provider?.authorizeUrl) return { opened: false, error: "Provider does not use a browser authorization page." };
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(login.authUrl);
    expected = new URL(provider.authorizeUrl);
  } catch {
    return { opened: false, error: "Authorization URL is invalid." };
  }
  if (actual.protocol !== "https:" || actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
    return { opened: false, error: "Authorization URL did not match the provider." };
  }
  return opener(actual.toString())
    ? { opened: true }
    : { opened: false, error: "This machine cannot open a graphical browser." };
}
