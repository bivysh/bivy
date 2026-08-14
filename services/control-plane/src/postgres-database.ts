// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type pg from "pg";

/** A checked-out connection whose transaction lifetime is explicit to callers. */
export interface PostgresTransactionContext {
  query: pg.PoolClient["query"];
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

/**
 * Owns database-level concerns shared by all repositories: pooled query retries,
 * idle-client failures, and creation of explicit transaction contexts.
 */
export class PostgresDatabaseContext {
  private static readonly RETRYABLE_CONNECT_CODES = new Set(["EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED"]);

  constructor(private readonly pool: pg.Pool) {
    this.pool.on("error", (err) => {
      console.error("Postgres idle client error (pool will reconnect):", err.message);
    });
  }

  async query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
    const maxRetries = 2;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.pool.query(text, params as unknown[] | undefined);
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const retryable = typeof code === "string" && PostgresDatabaseContext.RETRYABLE_CONNECT_CODES.has(code);
        if (attempt >= maxRetries || !retryable) throw err;
        const backoffMs = 100 * 2 ** attempt;
        console.warn(`Postgres connect error (retry ${attempt + 1}/${maxRetries} in ${backoffMs}ms):`, (err as Error).message);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  async beginTransaction(): Promise<PostgresTransactionContext> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
    } catch (error) {
      client.release();
      throw error;
    }
    return {
      query: client.query.bind(client) as pg.PoolClient["query"],
      commit: async () => { await client.query("COMMIT"); },
      rollback: async () => { await client.query("ROLLBACK"); },
      release: () => client.release(),
    };
  }
}
