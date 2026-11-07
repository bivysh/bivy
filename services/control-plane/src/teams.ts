// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { PostgresDatabaseContext, PostgresTransactionContext } from "./postgres-database.js";

/**
 * Teams: a named group of accounts with admin/member roles and invites.
 *
 * The control plane keeps only the roster — who is in which team, with which
 * role, and pending invites. It never holds team content; anything a team
 * shares between members is end-to-end encrypted by their own devices and
 * machines. An account belongs to at most one team.
 */

export type TeamRole = "admin" | "member";
export const TEAM_ROLES: readonly TeamRole[] = ["admin", "member"];

export interface Team {
  id: string;
  name: string;
  createdAt: string;
}

export interface TeamMembership {
  team: Team;
  role: TeamRole;
}

export interface TeamMember {
  accountId: string;
  email: string;
  role: TeamRole;
  joinedAt: string;
}

export interface TeamInvite {
  id: string;
  teamId: string;
  /** Set for an email invite: only that address may accept it. */
  email?: string;
  role: TeamRole;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
}

/** What someone holding an invite link may see before joining. */
export interface TeamInvitePreview {
  teamName: string;
  invitedBy?: string;
  role: TeamRole;
  email?: string;
  expiresAt: string;
}

export interface TeamInviteInput {
  email?: string;
  role: TeamRole;
  ttlMs?: number;
  maxUses?: number;
}

/** Limits that keep one team from growing the roster tables without bound.
 * Product limits (seats) are the deployment's to decide, through admission. */
export const TEAM_LIMITS = {
  nameMax: 60,
  inviteTtlDefaultMs: 7 * 24 * 60 * 60_000,
  inviteTtlMaxMs: 30 * 24 * 60 * 60_000,
  linkInviteUsesDefault: 25,
  linkInviteUsesMax: 500,
  activeInvitesMax: 100,
} as const;

export class TeamError extends Error {
  constructor(readonly code: TeamErrorCode, readonly status: number, message: string) { super(message); }
}

export type TeamErrorCode =
  | "invalid-name"
  | "invalid-invite"
  | "already-in-team"
  | "not-in-team"
  | "not-a-member"
  | "last-admin"
  | "invite-unavailable"
  | "invite-email-mismatch"
  | "too-many-invites";

const TEAM_ERRORS: Record<TeamErrorCode, [number, string]> = {
  "invalid-name": [400, `A team name is 1–${TEAM_LIMITS.nameMax} characters`],
  "invalid-invite": [400, "That invite isn't valid"],
  "already-in-team": [409, "You're already in a team. Leave it first."],
  "not-in-team": [404, "You're not in a team"],
  "not-a-member": [404, "That account isn't in this team"],
  "last-admin": [409, "A team needs at least one admin. Make someone else an admin first."],
  "invite-unavailable": [404, "This invite has expired, been used up or been revoked"],
  "invite-email-mismatch": [403, "This invite is for a different email address"],
  "too-many-invites": [409, `A team can have at most ${TEAM_LIMITS.activeInvitesMax} open invites`],
};

export function teamError(code: TeamErrorCode): TeamError {
  const [status, message] = TEAM_ERRORS[code];
  return new TeamError(code, status, message);
}

export function normalizeTeamName(input: unknown): string {
  const name = typeof input === "string" ? input.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > TEAM_LIMITS.nameMax) throw teamError("invalid-name");
  return name;
}

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === "string" && (TEAM_ROLES as readonly string[]).includes(value);
}

/** One `@`, no whitespace, a dotted domain. String checks, not a regex, so a
 * hostile address can't make matching slow. */
function plausibleEmail(email: string): boolean {
  if (email.length > 254 || /\s/.test(email)) return false;
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@")) return false;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

/** Clamp an invite request to the roster limits. An email invite is for one
 * person, so it is always single-use. */
export function normalizeTeamInvite(input: { email?: unknown; role?: unknown; ttlMs?: unknown; maxUses?: unknown }): TeamInviteInput {
  const role = input.role === undefined ? "member" : input.role;
  if (!isTeamRole(role)) throw teamError("invalid-invite");
  const email = typeof input.email === "string" && input.email.trim() ? input.email.trim().toLowerCase() : undefined;
  if (email !== undefined && !plausibleEmail(email)) throw teamError("invalid-invite");
  const ttl = Number(input.ttlMs ?? TEAM_LIMITS.inviteTtlDefaultMs);
  if (!Number.isFinite(ttl) || ttl <= 0) throw teamError("invalid-invite");
  const ttlMs = Math.min(ttl, TEAM_LIMITS.inviteTtlMaxMs);
  if (email) return { email, role, ttlMs, maxUses: 1 };
  const uses = Math.floor(Number(input.maxUses ?? TEAM_LIMITS.linkInviteUsesDefault));
  if (!Number.isFinite(uses) || uses < 1) throw teamError("invalid-invite");
  return { role, ttlMs, maxUses: Math.min(uses, TEAM_LIMITS.linkInviteUsesMax) };
}

export interface TeamRepository {
  init(): Promise<void>;
  teamOf(accountId: string): Promise<TeamMembership | undefined>;
  createTeam(accountId: string, name: string): Promise<TeamMembership>;
  renameTeam(teamId: string, name: string): Promise<Team>;
  deleteTeam(teamId: string): Promise<void>;
  listMembers(teamId: string): Promise<TeamMember[]>;
  countMembers(teamId: string): Promise<number>;
  setMemberRole(teamId: string, accountId: string, role: TeamRole): Promise<void>;
  /** Remove one member. The last member leaving deletes the team; the last
   * admin cannot leave while others remain. Returns whether the team survives. */
  removeMember(teamId: string, accountId: string): Promise<{ teamDeleted: boolean }>;
  /** Before an account is deleted: hand admin to the longest-serving member
   * if it was the last admin, then remove it. */
  releaseAccount(accountId: string): Promise<void>;
  createInvite(teamId: string, createdBy: string, input: TeamInviteInput): Promise<{ invite: TeamInvite; token: string }>;
  listInvites(teamId: string): Promise<TeamInvite[]>;
  revokeInvite(teamId: string, inviteId: string): Promise<boolean>;
  previewInvite(token: string): Promise<(TeamInvitePreview & { teamId: string }) | undefined>;
  acceptInvite(token: string, account: { id: string; email: string }): Promise<TeamMembership>;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const iso = (value: unknown) => new Date(value as string).toISOString();

function teamFromRow(row: Record<string, any>): Team {
  return { id: String(row.id), name: String(row.name), createdAt: iso(row.created_at) };
}

function inviteFromRow(row: Record<string, any>): TeamInvite {
  return {
    id: String(row.id), teamId: String(row.team_id),
    ...(row.email ? { email: String(row.email) } : {}),
    role: row.role === "admin" ? "admin" : "member",
    createdBy: String(row.created_by), createdAt: iso(row.created_at), expiresAt: iso(row.expires_at),
    maxUses: Number(row.max_uses), uses: Number(row.uses),
  };
}

/** The account_id primary key is what keeps an account in one team, even
 * when two joins race; a lost race surfaces as already-in-team. */
async function join(tx: PostgresTransactionContext, accountId: string, teamId: string, role: TeamRole): Promise<void> {
  const existing = await tx.query(`SELECT 1 FROM team_members WHERE account_id = $1`, [accountId]);
  if (existing.rows.length) throw teamError("already-in-team");
  try {
    await tx.query(`INSERT INTO team_members (account_id, team_id, role) VALUES ($1, $2, $3)`, [accountId, teamId, role]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw teamError("already-in-team");
    throw error;
  }
}

const ACTIVE_INVITE = `revoked_at IS NULL AND expires_at > now() AND uses < max_uses`;

/** What the roster tells the team vault when someone leaves. */
export interface TeamDepartures {
  memberLeft(teamId: string, accountId: string): Promise<void>;
}

export class PostgresTeams implements TeamRepository {
  constructor(private readonly database: PostgresDatabaseContext, private readonly departures?: TeamDepartures) {}

  private query(text: string, params?: unknown[]) { return this.database.query(text, params); }

  async init(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS team_members (
        account_id  TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        role        TEXT NOT NULL,
        joined_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS team_members_team_idx ON team_members (team_id, joined_at);
      CREATE TABLE IF NOT EXISTS team_invites (
        id          TEXT PRIMARY KEY,
        team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        token_hash  TEXT UNIQUE NOT NULL,
        email       TEXT,
        role        TEXT NOT NULL,
        created_by  TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at  TIMESTAMPTZ NOT NULL,
        max_uses    INTEGER NOT NULL,
        uses        INTEGER NOT NULL DEFAULT 0,
        revoked_at  TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS team_invites_team_idx ON team_invites (team_id, created_at DESC);
    `);
  }

  async teamOf(accountId: string): Promise<TeamMembership | undefined> {
    const { rows } = await this.query(
      `SELECT t.id, t.name, t.created_at, m.role FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.account_id = $1`,
      [accountId],
    );
    const row = rows[0];
    return row ? { team: teamFromRow(row), role: row.role === "admin" ? "admin" : "member" } : undefined;
  }

  async createTeam(accountId: string, name: string): Promise<TeamMembership> {
    const clean = normalizeTeamName(name);
    const tx = await this.database.beginTransaction();
    try {
      const id = `team_${randomUUID()}`;
      const { rows } = await tx.query(`INSERT INTO teams (id, name) VALUES ($1, $2) RETURNING *`, [id, clean]);
      await join(tx, accountId, id, "admin");
      await tx.commit();
      return { team: teamFromRow(rows[0]), role: "admin" };
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally { tx.release(); }
  }

  async renameTeam(teamId: string, name: string): Promise<Team> {
    const { rows } = await this.query(`UPDATE teams SET name = $2 WHERE id = $1 RETURNING *`, [teamId, normalizeTeamName(name)]);
    if (!rows[0]) throw teamError("not-in-team");
    return teamFromRow(rows[0]);
  }

  async deleteTeam(teamId: string): Promise<void> {
    await this.query(`DELETE FROM team_invites WHERE team_id = $1`, [teamId]);
    await this.query(`DELETE FROM team_shared_nodes WHERE node_id IN (SELECT n.id FROM nodes n JOIN team_members m ON m.account_id = n.account_id WHERE m.team_id = $1)`, [teamId]);
    await this.query(`DELETE FROM team_members WHERE team_id = $1`, [teamId]);
    await this.query(`DELETE FROM teams WHERE id = $1`, [teamId]);
  }

  async listMembers(teamId: string): Promise<TeamMember[]> {
    const { rows } = await this.query(
      `SELECT m.account_id, a.email, m.role, m.joined_at FROM team_members m JOIN accounts a ON a.id = m.account_id
       WHERE m.team_id = $1 ORDER BY m.joined_at, m.account_id`,
      [teamId],
    );
    return rows.map((row) => ({
      accountId: String(row.account_id), email: String(row.email),
      role: row.role === "admin" ? "admin" : "member", joinedAt: iso(row.joined_at),
    }));
  }

  async countMembers(teamId: string): Promise<number> {
    const { rows } = await this.query(`SELECT COUNT(*) AS n FROM team_members WHERE team_id = $1`, [teamId]);
    return Number(rows[0]?.n ?? 0);
  }

  private async roles(teamId: string): Promise<Map<string, TeamRole>> {
    const members = await this.listMembers(teamId);
    return new Map(members.map((m) => [m.accountId, m.role]));
  }

  async setMemberRole(teamId: string, accountId: string, role: TeamRole): Promise<void> {
    const roles = await this.roles(teamId);
    const current = roles.get(accountId);
    if (!current) throw teamError("not-a-member");
    if (current === role) return;
    if (current === "admin" && [...roles.values()].filter((r) => r === "admin").length === 1) throw teamError("last-admin");
    await this.query(`UPDATE team_members SET role = $3 WHERE team_id = $1 AND account_id = $2`, [teamId, accountId, role]);
  }

  async removeMember(teamId: string, accountId: string): Promise<{ teamDeleted: boolean }> {
    const roles = await this.roles(teamId);
    const current = roles.get(accountId);
    if (!current) throw teamError("not-a-member");
    if (roles.size === 1) {
      await this.deleteTeam(teamId);
      return { teamDeleted: true };
    }
    if (current === "admin" && [...roles.values()].filter((r) => r === "admin").length === 1) throw teamError("last-admin");
    await this.departures?.memberLeft(teamId, accountId);
    // A machine is shared with one team: the one its owner was in when they
    // turned sharing on. Leaving ends that, so it can't carry into a next team.
    await this.query(`DELETE FROM team_shared_nodes WHERE node_id IN (SELECT id FROM nodes WHERE account_id = $1)`, [accountId]);
    await this.query(`DELETE FROM team_members WHERE team_id = $1 AND account_id = $2`, [teamId, accountId]);
    return { teamDeleted: false };
  }

  async releaseAccount(accountId: string): Promise<void> {
    const membership = await this.teamOf(accountId);
    if (!membership) return;
    const teamId = membership.team.id;
    const members = await this.listMembers(teamId);
    const others = members.filter((m) => m.accountId !== accountId);
    if (membership.role === "admin" && others.length && !others.some((m) => m.role === "admin")) {
      await this.setMemberRole(teamId, others[0]!.accountId, "admin");
    }
    await this.removeMember(teamId, accountId);
  }

  async createInvite(teamId: string, createdBy: string, input: TeamInviteInput): Promise<{ invite: TeamInvite; token: string }> {
    const { rows: open } = await this.query(`SELECT COUNT(*) AS n FROM team_invites WHERE team_id = $1 AND ${ACTIVE_INVITE}`, [teamId]);
    if (Number(open[0]?.n ?? 0) >= TEAM_LIMITS.activeInvitesMax) throw teamError("too-many-invites");
    const token = `tin_${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + (input.ttlMs ?? TEAM_LIMITS.inviteTtlDefaultMs));
    const { rows } = await this.query(
      `INSERT INTO team_invites (id, team_id, token_hash, email, role, created_by, expires_at, max_uses)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [randomUUID(), teamId, hashToken(token), input.email ?? null, input.role, createdBy, expiresAt, input.maxUses ?? 1],
    );
    return { invite: inviteFromRow(rows[0]), token };
  }

  async listInvites(teamId: string): Promise<TeamInvite[]> {
    const { rows } = await this.query(
      `SELECT * FROM team_invites WHERE team_id = $1 AND ${ACTIVE_INVITE} ORDER BY created_at DESC`, [teamId],
    );
    return rows.map(inviteFromRow);
  }

  async revokeInvite(teamId: string, inviteId: string): Promise<boolean> {
    const { rowCount } = await this.query(
      `UPDATE team_invites SET revoked_at = now() WHERE team_id = $1 AND id = $2 AND revoked_at IS NULL`, [teamId, inviteId],
    );
    return Boolean(rowCount);
  }

  async previewInvite(token: string): Promise<(TeamInvitePreview & { teamId: string }) | undefined> {
    if (!token.startsWith("tin_")) return undefined;
    const { rows } = await this.query(
      `SELECT i.*, t.name AS team_name, a.email AS inviter_email FROM team_invites i
       JOIN teams t ON t.id = i.team_id LEFT JOIN accounts a ON a.id = i.created_by
       WHERE i.token_hash = $1 AND i.revoked_at IS NULL AND i.expires_at > now() AND i.uses < i.max_uses`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) return undefined;
    const invite = inviteFromRow(row);
    return {
      teamId: invite.teamId, teamName: String(row.team_name), role: invite.role, expiresAt: invite.expiresAt,
      ...(row.inviter_email ? { invitedBy: String(row.inviter_email) } : {}),
      ...(invite.email ? { email: invite.email } : {}),
    };
  }

  async acceptInvite(token: string, account: { id: string; email: string }): Promise<TeamMembership> {
    const preview = await this.previewInvite(token);
    if (!preview) throw teamError("invite-unavailable");
    if (preview.email && preview.email !== account.email.trim().toLowerCase()) throw teamError("invite-email-mismatch");
    const current = await this.teamOf(account.id);
    // Opening the same link twice is not a second join, and spends no use.
    if (current?.team.id === preview.teamId) return current;
    if (current) throw teamError("already-in-team");
    const tx = await this.database.beginTransaction();
    try {
      const spent = await tx.query(
        `UPDATE team_invites SET uses = uses + 1 WHERE token_hash = $1 AND ${ACTIVE_INVITE} RETURNING team_id, role`,
        [hashToken(token)],
      );
      const invite = spent.rows[0];
      if (!invite) throw teamError("invite-unavailable");
      await join(tx, account.id, String(invite.team_id), invite.role === "admin" ? "admin" : "member");
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally { tx.release(); }
    const membership = await this.teamOf(account.id);
    if (!membership) throw teamError("invite-unavailable");
    return membership;
  }
}
