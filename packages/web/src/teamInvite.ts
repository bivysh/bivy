// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Team invite landing: `/team/join#tin_…` (services/control-plane/src/team-routes.ts).
//
// The token is in the fragment so no server logs it. Before the app mounts it
// is moved into storage and the URL becomes `/settings/team`, where the Team
// panel offers to join. The hash has to go before the controller boots: it
// reads a `#payload` as a device-link code. Local (not tab) storage, so an
// invite opened while signed out survives a sign-in that lands in a new tab.

export const TEAM_JOIN_PATH = "/team/join";
export const PENDING_TEAM_INVITE_KEY = "bivy.pendingTeamInvite";

const TOKEN = /^tin_[A-Za-z0-9_-]{16,128}$/;

type InviteStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Returns where to send the browser when `pathname` is the join route, else null. */
export function applyTeamInvite(pathname: string, hash: string, storage: InviteStorage): string | null {
  if (pathname.replace(/\/+$/, "") !== TEAM_JOIN_PATH) return null;
  const token = hash.replace(/^#/, "");
  if (TOKEN.test(token)) {
    try { storage.setItem(PENDING_TEAM_INVITE_KEY, token); } catch { /* denied: the link can be opened again */ }
  }
  return "/settings/team";
}

export function peekTeamInvite(storage: InviteStorage = localStorage): string | null {
  try {
    const token = storage.getItem(PENDING_TEAM_INVITE_KEY);
    return token && TOKEN.test(token) ? token : null;
  } catch { return null; }
}

export function clearTeamInvite(storage: InviteStorage = localStorage): void {
  try { storage.removeItem(PENDING_TEAM_INVITE_KEY); } catch { /* already gone */ }
}

/** Browser wiring; must run before mount.js is imported (see main.tsx). */
export function consumeTeamInvite(): void {
  const redirect = applyTeamInvite(location.pathname, location.hash, localStorage);
  if (redirect) history.replaceState(null, "", redirect);
}
