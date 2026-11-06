// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad

/**
 * Who may refresh a subscription sign-in, and when.
 *
 * Anthropic and OpenAI rotate the refresh token on every grant, so two machines
 * refreshing copies of one login lock each other out. A sign-in kept on one
 * machine (`sync: "node"`) is refreshed there. A sign-in synced to the account
 * is refreshed by whichever machine holds the account's refresh lease for it:
 * the holder refreshes, writes the new token back to the end-to-end vault, and
 * only then gives the lease up, so the next machine starts from the new token.
 * That way a sign-in stays alive with no persistent machine at all.
 *
 * `BIVY_OAUTH_REFRESH=0` (set on runners) means: refresh only while holding the
 * lease. Without a reachable control plane such a machine uses the access
 * tokens it was given and never spends the refresh token.
 */
export function oauthRefreshAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BIVY_OAUTH_REFRESH !== "0";
}

/** This machine's turn to refresh one account-synced sign-in. */
export interface RefreshTurn {
  /** Publish the refreshed sign-in (when `refreshed`), then give the turn up. */
  finish(refreshed: boolean): Promise<void>;
}

/**
 * What a turn request can come back with:
 * - a turn: refresh now;
 * - `"busy"`: another machine refreshed or is refreshing, and this machine has
 *   imported whatever it published; re-read the credential instead;
 * - undefined: no coordination is available (no control plane, or one that
 *   predates leases), so fall back to `oauthRefreshAllowed`.
 */
export type RefreshTurnResult = RefreshTurn | "busy" | undefined;

export interface RefreshCoordinator {
  /** `isFresh` reports whether the stored credential no longer needs a refresh. */
  take(provider: string, label: string, isFresh: () => Promise<boolean>): Promise<RefreshTurnResult>;
}

let coordinator: RefreshCoordinator | undefined;

/** Installed by the daemon once it is enrolled with a control plane. */
export function setRefreshCoordinator(next: RefreshCoordinator | undefined): void {
  coordinator = next;
}

export function refreshCoordinator(): RefreshCoordinator | undefined {
  return coordinator;
}
