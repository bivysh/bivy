// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { randomUUID } from "node:crypto";

import type { PostgresDatabaseContext } from "./postgres-database.js";

/**
 * Team administration: the switches admins set for the whole team, and the
 * activity log of roster and access changes.
 *
 * The log records who did what to the roster and to access (members, roles,
 * invites, shared machines, session invites). It never records session
 * content; the control plane doesn't have any.
 */

export interface TeamPolicies {
  /** Members may share their machines with the team (team-machines.ts). */
  shareMachines: boolean;
  /** Members may invite teammates into single sessions. */
  sessionInvites: boolean;
}

export const DEFAULT_TEAM_POLICIES: TeamPolicies = { shareMachines: true, sessionInvites: true };

/** What can appear in the log. Adding an action is adding a row here. */
export const TEAM_ACTIONS = {
  "team.created": "Started the team",
  "team.renamed": "Renamed the team",
  "team.policies": "Changed team policies",
  "invite.created": "Created an invite",
  "invite.revoked": "Revoked an invite",
  "member.joined": "Joined",
  "member.left": "Left",
  "member.removed": "Removed a member",
  "member.role": "Changed a role",
  "machine.shared": "Shared a machine",
  "machine.unshared": "Stopped sharing a machine",
  "session-invites.changed": "Changed session invites on a machine",
} as const;
export type TeamAction = keyof typeof TEAM_ACTIONS;

export interface TeamAuditEvent {
  id: string;
  at: string;
  actorEmail: string;
  action: TeamAction;
  label: string;
  /** Content-free details: an email, a role, a machine name, a count. */
  detail: Record<string, string | number | boolean>;
}

export const TEAM_AUDIT_KEEP = 1000;

const iso = (value: unknown) => new Date(value as string).toISOString();

export class PostgresTeamAdmin {
  constructor(private readonly database: PostgresDatabaseContext, private readonly keep = TEAM_AUDIT_KEEP) {}

  private query(text: string, params?: unknown[]) { return this.database.query(text, params); }

  async init(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS team_policies (
        team_id          TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
        share_machines   BOOLEAN NOT NULL DEFAULT true,
        session_invites  BOOLEAN NOT NULL DEFAULT true,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS team_audit (
        id           TEXT PRIMARY KEY,
        team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        actor_email  TEXT NOT NULL,
        action       TEXT NOT NULL,
        detail       JSONB NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS team_audit_team_idx ON team_audit (team_id, at DESC);
    `);
  }

  async policies(teamId: string): Promise<TeamPolicies> {
    const { rows } = await this.query(`SELECT share_machines, session_invites FROM team_policies WHERE team_id = $1`, [teamId]);
    const row = rows[0];
    return row ? { shareMachines: Boolean(row.share_machines), sessionInvites: Boolean(row.session_invites) } : { ...DEFAULT_TEAM_POLICIES };
  }

  /** The policies of the team a machine's owner is in (defaults when none). */
  async policiesForNode(nodeId: string): Promise<TeamPolicies> {
    const { rows } = await this.query(
      `SELECT m.team_id FROM nodes n JOIN team_members m ON m.account_id = n.account_id WHERE n.id = $1`, [nodeId],
    );
    return rows[0] ? this.policies(String(rows[0].team_id)) : { ...DEFAULT_TEAM_POLICIES };
  }

  /**
   * Save policies. Turning one off ends what it allowed right away: shared
   * machines stop being shared and session invites are dropped, for every
   * member's machines. Machines remove the devices on their next check.
   */
  async setPolicies(teamId: string, patch: Partial<TeamPolicies>): Promise<TeamPolicies> {
    const next = { ...(await this.policies(teamId)), ...patch };
    await this.query(
      `INSERT INTO team_policies (team_id, share_machines, session_invites) VALUES ($1, $2, $3)
       ON CONFLICT (team_id) DO UPDATE SET share_machines = EXCLUDED.share_machines, session_invites = EXCLUDED.session_invites, updated_at = now()`,
      [teamId, next.shareMachines, next.sessionInvites],
    );
    const teamNodes = `SELECT n.id FROM nodes n JOIN team_members m ON m.account_id = n.account_id WHERE m.team_id = $1`;
    if (!next.shareMachines) await this.query(`DELETE FROM team_shared_nodes WHERE node_id IN (${teamNodes})`, [teamId]);
    if (!next.sessionInvites) await this.query(`DELETE FROM team_session_invites WHERE node_id IN (${teamNodes})`, [teamId]);
    return next;
  }

  async record(teamId: string, actorEmail: string, action: TeamAction, detail: TeamAuditEvent["detail"] = {}): Promise<void> {
    await this.query(
      `INSERT INTO team_audit (id, team_id, actor_email, action, detail) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), teamId, actorEmail, action, JSON.stringify(detail)],
    );
    // Keep the newest `keep` per team.
    await this.query(
      `DELETE FROM team_audit WHERE team_id = $1 AND id NOT IN (
         SELECT id FROM team_audit WHERE team_id = $1 ORDER BY at DESC LIMIT ${Math.max(1, Math.floor(this.keep))})`,
      [teamId],
    );
  }

  async audit(teamId: string, limit = 100): Promise<TeamAuditEvent[]> {
    const { rows } = await this.query(
      `SELECT * FROM team_audit WHERE team_id = $1 ORDER BY at DESC LIMIT $2`, [teamId, Math.min(Math.max(limit, 1), 500)],
    );
    return rows.map((row) => {
      const action = (row.action in TEAM_ACTIONS ? row.action : "team.policies") as TeamAction;
      const detail = typeof row.detail === "string" ? JSON.parse(row.detail) : (row.detail ?? {});
      return { id: String(row.id), at: iso(row.at), actorEmail: String(row.actor_email), action, label: TEAM_ACTIONS[action], detail };
    });
  }
}
