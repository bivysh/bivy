// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// Client for the control plane's team roster (services/control-plane/src/team-routes.ts).

import type { LocalStore } from "./local-store.js";

export type TeamRole = "admin" | "member";

export interface TeamMemberView {
  accountId: string;
  email: string;
  role: TeamRole;
  joinedAt: string;
}

export interface TeamInviteView {
  id: string;
  /** Email invites are for one address; link invites have no email. */
  email?: string;
  role: TeamRole;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
}

export type TeamView =
  | { team: null }
  | {
    team: { id: string; name: string; createdAt: string };
    role: TeamRole;
    members: TeamMemberView[];
    /** Open invites; only admins see them. */
    invites: TeamInviteView[];
    policies?: TeamPolicies;
  };

/** What admins allow for the whole team. */
export interface TeamPolicies {
  shareMachines: boolean;
  sessionInvites: boolean;
}

export interface TeamActivityEvent {
  id: string;
  at: string;
  actorEmail: string;
  action: string;
  label: string;
  detail: Record<string, string | number | boolean>;
}

export interface TeamInvitePreview {
  teamName: string;
  invitedBy?: string;
  role: TeamRole;
  email?: string;
  expiresAt: string;
  alreadyMember: boolean;
  inOtherTeam: boolean;
}

export interface CreatedTeamInvite {
  invite: TeamInviteView;
  url: string;
  emailed: boolean;
}

/** A refusal from the control plane or the deployment, with its stable code. */
export class TeamRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "TeamRequestError";
  }
}

async function teamRequest<T>(store: LocalStore, path: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const base = (store.cp || (typeof location !== "undefined" ? location.origin : "")).replace(/\/$/, "");
  const res = await fetchImpl(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${store.s}`, "content-type": "application/json" },
  });
  const data = await res.json().catch(() => ({})) as { error?: string; code?: string };
  if (!res.ok) throw new TeamRequestError(data.error || `team request failed: ${res.status}`, res.status, data.code);
  return data as T;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const fetchTeam = (store: LocalStore, f?: typeof fetch) => teamRequest<TeamView>(store, "/account/team", {}, f);
export const createTeam = (store: LocalStore, name: string, f?: typeof fetch) => teamRequest<TeamView>(store, "/account/team", json("POST", { name }), f);
export const renameTeam = (store: LocalStore, name: string, f?: typeof fetch) => teamRequest<TeamView>(store, "/account/team", json("PATCH", { name }), f);
export const deleteTeam = (store: LocalStore, f?: typeof fetch) => teamRequest<TeamView>(store, "/account/team", json("DELETE"), f);
export const createTeamInvite = (store: LocalStore, input: { email?: string; role?: TeamRole; maxUses?: number; ttlMs?: number }, f?: typeof fetch) =>
  teamRequest<CreatedTeamInvite>(store, "/account/team/invites", json("POST", input), f);
export const revokeTeamInvite = (store: LocalStore, id: string, f?: typeof fetch) =>
  teamRequest<{ ok: true }>(store, `/account/team/invites/${encodeURIComponent(id)}`, json("DELETE"), f);
export const setTeamMemberRole = (store: LocalStore, accountId: string, role: TeamRole, f?: typeof fetch) =>
  teamRequest<TeamView>(store, `/account/team/members/${encodeURIComponent(accountId)}`, json("PATCH", { role }), f);
/** Remove a member, or pass your own account id to leave. */
export const removeTeamMember = (store: LocalStore, accountId: string, f?: typeof fetch) =>
  teamRequest<TeamView>(store, `/account/team/members/${encodeURIComponent(accountId)}`, json("DELETE"), f);
export const previewTeamInvite = (store: LocalStore, token: string, f?: typeof fetch) =>
  teamRequest<TeamInvitePreview>(store, "/account/team/invite-preview", json("POST", { token }), f);
export const joinTeam = (store: LocalStore, token: string, f?: typeof fetch) =>
  teamRequest<TeamView>(store, "/account/team/join", json("POST", { token }), f);
export const setTeamPolicies = (store: LocalStore, patch: Partial<TeamPolicies>, f?: typeof fetch) =>
  teamRequest<{ policies: TeamPolicies }>(store, "/account/team/policies", json("PATCH", patch), f);
/** Admins only: recent changes to the team's roster and access, newest first. */
export const fetchTeamActivity = (store: LocalStore, f?: typeof fetch) =>
  teamRequest<{ events: TeamActivityEvent[] }>(store, "/account/team/activity", {}, f);
