// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import type { PostgresDatabaseContext } from "./postgres-database.js";

/**
 * The team vault: one end-to-end encrypted blob per team (team instructions
 * today), readable by the machines of every team member.
 *
 * Same shape as the account's model-auth vault, across accounts: the control
 * plane stores the ciphertext and, per recipient machine, the vault key sealed
 * under an ECDH key between two machines. It can't open either. A machine
 * without the key asks for it; a machine that holds it seals it for the asker,
 * and the control plane only lists askers that are machines of current
 * members. Only admins' machines may write.
 *
 * When a member leaves (or one of their machines is removed), the vault is
 * flagged: the next write must use a fresh key, which is then sealed only for
 * the machines still in the team.
 */

export interface TeamVault {
  ciphertext: string;
  /** Advances on every write; a writer must name the one it read. */
  generation: number;
  /** Advances on every fresh key. */
  keyGeneration: number;
  needsRotation: boolean;
  updatedAt: string;
  updatedByNodeId: string;
}

export interface TeamVaultWrappedKey {
  wrappedKey: string;
  wrappedByPublicKey: string;
  keyGeneration: number;
}

export interface TeamVaultKeyRequest {
  nodeId: string;
  publicKey: string;
}

export interface TeamVaultSnapshot {
  vault?: TeamVault;
  /** The key sealed for the asking machine, if one has been. */
  wrappedKey?: TeamVaultWrappedKey;
  /** Other team machines waiting for the key. */
  requests: TeamVaultKeyRequest[];
}

export class TeamVaultError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** A team machine: a node whose account is a member of the team. */
const TEAM_NODE = `SELECT n.id FROM nodes n JOIN team_members m ON m.account_id = n.account_id WHERE m.team_id = $1`;

export const TEAM_VAULT_MAX_CIPHERTEXT = 64 * 1024;

const iso = (value: unknown) => new Date(value as string).toISOString();

export class PostgresTeamVault {
  constructor(private readonly database: PostgresDatabaseContext) {}

  private query(text: string, params?: unknown[]) { return this.database.query(text, params); }

  async init(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS team_vaults (
        team_id            TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
        ciphertext         TEXT NOT NULL,
        generation         INTEGER NOT NULL DEFAULT 1,
        key_generation     INTEGER NOT NULL DEFAULT 1,
        needs_rotation     BOOLEAN NOT NULL DEFAULT false,
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by_node_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_vault_keys (
        team_id              TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        node_id              TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        wrapped_key          TEXT NOT NULL,
        wrapped_by_public_key TEXT NOT NULL,
        key_generation       INTEGER NOT NULL,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (team_id, node_id)
      );
      CREATE TABLE IF NOT EXISTS team_vault_key_requests (
        team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        public_key  TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (team_id, node_id)
      );
    `);
  }

  private async vault(teamId: string): Promise<TeamVault | undefined> {
    const { rows } = await this.query(`SELECT * FROM team_vaults WHERE team_id = $1`, [teamId]);
    const row = rows[0];
    return row ? {
      ciphertext: String(row.ciphertext), generation: Number(row.generation), keyGeneration: Number(row.key_generation),
      needsRotation: Boolean(row.needs_rotation), updatedAt: iso(row.updated_at), updatedByNodeId: String(row.updated_by_node_id),
    } : undefined;
  }

  private async isTeamNode(teamId: string, nodeId: string): Promise<boolean> {
    const { rows } = await this.query(`${TEAM_NODE} AND n.id = $2`, [teamId, nodeId]);
    return rows.length > 0;
  }

  async snapshot(teamId: string, nodeId: string): Promise<TeamVaultSnapshot> {
    const vault = await this.vault(teamId);
    const { rows: keys } = await this.query(
      `SELECT * FROM team_vault_keys WHERE team_id = $1 AND node_id = $2`, [teamId, nodeId],
    );
    const { rows: requests } = await this.query(
      `SELECT r.node_id, r.public_key FROM team_vault_key_requests r
       WHERE r.team_id = $1 AND r.node_id <> $2 AND r.node_id IN (${TEAM_NODE})
       ORDER BY r.created_at`,
      [teamId, nodeId],
    );
    const key = keys[0];
    return {
      ...(vault ? { vault } : {}),
      ...(key ? { wrappedKey: { wrappedKey: String(key.wrapped_key), wrappedByPublicKey: String(key.wrapped_by_public_key), keyGeneration: Number(key.key_generation) } } : {}),
      requests: requests.map((r) => ({ nodeId: String(r.node_id), publicKey: String(r.public_key) })),
    };
  }

  /**
   * Store new ciphertext. `expectedGeneration` is the generation the writer
   * read (0 when there was no vault): a stale write fails, so two admins can't
   * silently overwrite each other. `freshKey` says the writer sealed it under
   * a key nobody else has yet; a flagged vault accepts nothing else.
   */
  async write(teamId: string, nodeId: string, input: { ciphertext: string; expectedGeneration: number; freshKey: boolean }): Promise<TeamVault> {
    if (!input.ciphertext || input.ciphertext.length > TEAM_VAULT_MAX_CIPHERTEXT) throw new TeamVaultError(400, "invalid-ciphertext", "Team vault ciphertext is missing or too large");
    const current = await this.vault(teamId);
    if ((current?.generation ?? 0) !== input.expectedGeneration) throw new TeamVaultError(409, "stale", "The team vault changed since this machine read it");
    if (current?.needsRotation && !input.freshKey) throw new TeamVaultError(409, "rotation-required", "A member left; write with a fresh key");
    const keyGeneration = !current ? 1 : current.keyGeneration + (input.freshKey ? 1 : 0);
    const tx = await this.database.beginTransaction();
    try {
      const { rowCount } = current
        ? await tx.query(
          `UPDATE team_vaults SET ciphertext = $2, generation = generation + 1, key_generation = $3, needs_rotation = false,
             updated_at = now(), updated_by_node_id = $4
           WHERE team_id = $1 AND generation = $5`,
          [teamId, input.ciphertext, keyGeneration, nodeId, current.generation],
        )
        : await tx.query(
          `INSERT INTO team_vaults (team_id, ciphertext, key_generation, updated_by_node_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (team_id) DO NOTHING`,
          [teamId, input.ciphertext, keyGeneration, nodeId],
        );
      if (!rowCount) throw new TeamVaultError(409, "stale", "The team vault changed since this machine read it");
      // Wraps of an older key no longer open anything; their machines ask again.
      if (input.freshKey) await tx.query(`DELETE FROM team_vault_keys WHERE team_id = $1 AND key_generation < $2`, [teamId, keyGeneration]);
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally { tx.release(); }
    return (await this.vault(teamId))!;
  }

  async requestKey(teamId: string, nodeId: string, publicKey: string): Promise<void> {
    if (!publicKey) throw new TeamVaultError(400, "invalid-request", "Missing publicKey");
    await this.query(
      `INSERT INTO team_vault_key_requests (team_id, node_id, public_key) VALUES ($1, $2, $3)
       ON CONFLICT (team_id, node_id) DO UPDATE SET public_key = EXCLUDED.public_key`,
      [teamId, nodeId, publicKey],
    );
  }

  /**
   * Seal the key for one team machine; answers (and clears) its request. A
   * machine seals for itself, or for a machine that asked: an unasked copy
   * would replace the one the target already opens.
   */
  async putWrappedKey(teamId: string, fromNodeId: string, targetNodeId: string, input: { wrappedKey: string; wrappedByPublicKey: string; keyGeneration: number }): Promise<void> {
    if (!input.wrappedKey || !input.wrappedByPublicKey) throw new TeamVaultError(400, "invalid-request", "Missing wrappedKey or wrappedByPublicKey");
    if (!(await this.isTeamNode(teamId, targetNodeId))) throw new TeamVaultError(403, "not-a-team-machine", "That machine isn't in this team");
    if (targetNodeId !== fromNodeId) {
      const { rows } = await this.query(`SELECT 1 FROM team_vault_key_requests WHERE team_id = $1 AND node_id = $2`, [teamId, targetNodeId]);
      if (!rows.length) throw new TeamVaultError(409, "not-requested", "That machine hasn't asked for the key");
    }
    const vault = await this.vault(teamId);
    if (vault && input.keyGeneration !== vault.keyGeneration) throw new TeamVaultError(409, "stale-key", "That key is no longer the team's key");
    await this.query(
      `INSERT INTO team_vault_keys (team_id, node_id, wrapped_key, wrapped_by_public_key, key_generation) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (team_id, node_id) DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key,
         wrapped_by_public_key = EXCLUDED.wrapped_by_public_key, key_generation = EXCLUDED.key_generation, updated_at = now()`,
      [teamId, targetNodeId, input.wrappedKey, input.wrappedByPublicKey, input.keyGeneration],
    );
    await this.query(`DELETE FROM team_vault_key_requests WHERE team_id = $1 AND node_id = $2`, [teamId, targetNodeId]);
  }

  /** A member left: forget their machines' wraps and requests, and require a fresh key. */
  async memberLeft(teamId: string, accountId: string): Promise<void> {
    const mine = `SELECT id FROM nodes WHERE account_id = $2`;
    const { rowCount } = await this.query(`DELETE FROM team_vault_keys WHERE team_id = $1 AND node_id IN (${mine})`, [teamId, accountId]);
    await this.query(`DELETE FROM team_vault_key_requests WHERE team_id = $1 AND node_id IN (${mine})`, [teamId, accountId]);
    if (rowCount) await this.query(`UPDATE team_vaults SET needs_rotation = true WHERE team_id = $1`, [teamId]);
  }

  /** SQL for PostgresStore.removeNode's transaction: flag every team vault the machine held a key to. */
  static readonly FLAG_FOR_REMOVED_NODE =
    `UPDATE team_vaults SET needs_rotation = true WHERE team_id IN (SELECT team_id FROM team_vault_keys WHERE node_id = $1)`;
}
