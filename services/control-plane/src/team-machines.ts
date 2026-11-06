// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import type { PostgresDatabaseContext } from "./postgres-database.js";

/**
 * Machines shared with a team. A machine's owner turns sharing on from the
 * machine itself, which then reports it here. Teammates may then pair their
 * devices with it and connect through the relay as if it were their own:
 * the relay sees the owner's account on both sides of the room.
 *
 * Pairing still ends on the machine, which refuses a teammate's device
 * unless sharing is on there too, so the control plane alone can't open a
 * machine to anyone. Each machine also checks who is still in the team and
 * drops teammates' devices that aren't (src/team-share.ts).
 */

export type MachineAccess =
  | { kind: "owner"; ownerAccountId: string }
  /** `guest`: reachable only through a session invite, not because it is shared. */
  | { kind: "teammate"; ownerAccountId: string; guest?: boolean };

/** A teammate invited into one session on a machine (src/session-invites.ts).
 * Routing metadata only: which account may reach which machine, until when. */
export interface SessionInviteRecord {
  accountId: string;
  sessionId: string;
  mode: "prompt" | "view";
  expiresAt: string;
}

export const MAX_SESSION_INVITES_PER_NODE = 100;

export interface SharedMachine {
  nodeId: string;
  ownerAccountId: string;
  ownerEmail: string;
}

export class PostgresTeamMachines {
  constructor(private readonly database: PostgresDatabaseContext) {}

  private query(text: string, params?: unknown[]) { return this.database.query(text, params); }

  async init(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS team_shared_nodes (
        node_id    TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        shared_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS team_session_invites (
        node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        session_id  TEXT NOT NULL,
        mode        TEXT NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (node_id, account_id, session_id)
      );
    `);
  }

  /** Replace a machine's session invites with what the machine reports. Only
   * current members of the owner's team are kept. */
  async setInvites(nodeId: string, invites: SessionInviteRecord[]): Promise<SessionInviteRecord[]> {
    const { memberAccountIds } = await this.shareState(nodeId);
    const owner = (await this.query(`SELECT account_id FROM nodes WHERE id = $1`, [nodeId])).rows[0]?.account_id;
    const members = new Set(memberAccountIds.filter((id) => id !== owner));
    const kept = invites
      .filter((i) => members.has(i.accountId) && i.sessionId && Date.parse(i.expiresAt) > Date.now())
      .slice(0, MAX_SESSION_INVITES_PER_NODE);
    await this.query(`DELETE FROM team_session_invites WHERE node_id = $1`, [nodeId]);
    for (const i of kept) {
      await this.query(
        `INSERT INTO team_session_invites (node_id, account_id, session_id, mode, expires_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (node_id, account_id, session_id) DO UPDATE SET mode = EXCLUDED.mode, expires_at = EXCLUDED.expires_at`,
        [nodeId, i.accountId, i.sessionId, i.mode === "view" ? "view" : "prompt", new Date(i.expiresAt)],
      );
    }
    return kept;
  }

  /** Machines where `accountId` has an open session invite from a teammate. */
  async invitedTo(accountId: string): Promise<Array<SharedMachine & { sessions: number }>> {
    const { rows } = await this.query(
      `SELECT n.id, n.account_id, a.email, COUNT(*) AS sessions FROM team_session_invites i
         JOIN nodes n ON n.id = i.node_id
         JOIN accounts a ON a.id = n.account_id
         JOIN team_members me ON me.account_id = i.account_id
         JOIN team_members owner ON owner.account_id = n.account_id AND owner.team_id = me.team_id
       WHERE i.account_id = $1 AND i.expires_at > now()
       GROUP BY n.id, n.account_id, a.email
       ORDER BY a.email, n.id`,
      [accountId],
    );
    return rows.map((row) => ({ nodeId: String(row.id), ownerAccountId: String(row.account_id), ownerEmail: String(row.email), sessions: Number(row.sessions) }));
  }

  async setShared(nodeId: string, shared: boolean): Promise<void> {
    if (shared) await this.query(`INSERT INTO team_shared_nodes (node_id) VALUES ($1) ON CONFLICT (node_id) DO NOTHING`, [nodeId]);
    else await this.query(`DELETE FROM team_shared_nodes WHERE node_id = $1`, [nodeId]);
  }

  async isShared(nodeId: string): Promise<boolean> {
    const { rows } = await this.query(`SELECT 1 FROM team_shared_nodes WHERE node_id = $1`, [nodeId]);
    return rows.length > 0;
  }

  /** Machines teammates of `accountId` share with its team (not its own). */
  async sharedWith(accountId: string): Promise<SharedMachine[]> {
    const { rows } = await this.query(
      `SELECT n.id, n.account_id, a.email FROM team_members me
         JOIN team_members m ON m.team_id = me.team_id AND m.account_id <> me.account_id
         JOIN nodes n ON n.account_id = m.account_id
         JOIN team_shared_nodes s ON s.node_id = n.id
         JOIN accounts a ON a.id = n.account_id
       WHERE me.account_id = $1
       ORDER BY a.email, n.id`,
      [accountId],
    );
    return rows.map((row) => ({ nodeId: String(row.id), ownerAccountId: String(row.account_id), ownerEmail: String(row.email) }));
  }

  /** How `accountId` may reach `nodeId`: as its owner, through the team, or not at all. */
  async access(accountId: string, nodeId: string): Promise<MachineAccess | undefined> {
    const { rows } = await this.query(`SELECT account_id FROM nodes WHERE id = $1`, [nodeId]);
    const owner = rows[0] ? String(rows[0].account_id) : undefined;
    if (!owner) return undefined;
    if (owner === accountId) return { kind: "owner", ownerAccountId: owner };
    const shared = (await this.sharedWith(accountId)).some((m) => m.nodeId === nodeId);
    if (shared) return { kind: "teammate", ownerAccountId: owner };
    const invited = (await this.invitedTo(accountId)).some((m) => m.nodeId === nodeId);
    return invited ? { kind: "teammate", ownerAccountId: owner, guest: true } : undefined;
  }

  /** What a machine needs to police its teammates' devices: whether it is
   * shared, and which accounts are in its owner's team right now. */
  async shareState(nodeId: string): Promise<{ shared: boolean; memberAccountIds: string[] }> {
    const { rows } = await this.query(
      `SELECT m.account_id FROM nodes n
         JOIN team_members mine ON mine.account_id = n.account_id
         JOIN team_members m ON m.team_id = mine.team_id
       WHERE n.id = $1`,
      [nodeId],
    );
    return { shared: await this.isShared(nodeId), memberAccountIds: rows.map((row) => String(row.account_id)) };
  }
}
