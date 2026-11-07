// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Refresh every account-synced subscription sign-in now, whether or not its
// access token has expired. A refresh-only cloud machine runs this when none of
// the account's machines has run for days, so a refresh token that would
// otherwise sit unused until it expires is exercised and rotated. Each refresh
// takes the account's refresh lease and publishes through the vault
// (refresh-policy.ts), so this never races another machine.

import { createCredentialVault } from "../credential-store.js";
import { isNativeOAuthProvider, refreshModelOAuthState } from "./model-oauth.js";

export interface SignInRefreshResult { refreshed: string[]; failed: string[] }

export async function refreshSyncedSignIns(credsDir: string): Promise<SignInRefreshResult> {
  const result: SignInRefreshResult = { refreshed: [], failed: [] };
  for (const record of await createCredentialVault(credsDir).listRecords()) {
    if (record.sync !== "account" || record.source.kind !== "stored" || record.source.cred.type !== "oauth") continue;
    if (!isNativeOAuthProvider(record.provider)) continue;
    const id = `${record.provider}:${record.label}`;
    // A window longer than any token's life: refresh now.
    const state = await refreshModelOAuthState(credsDir, record.provider, record.label, undefined, Number.MAX_SAFE_INTEGER);
    (state.state === "expired" ? result.refreshed : result.failed).push(id);
  }
  return result;
}
