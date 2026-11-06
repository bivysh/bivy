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
  | { kind: "teammate"; ownerAccountId: string };

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
    `);
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
    return shared ? { kind: "teammate", ownerAccountId: owner } : undefined;
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
