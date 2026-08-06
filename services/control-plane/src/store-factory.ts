// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { MeshStore } from "./store.js";
import { PostgresStore } from "./postgres-store.js";

/**
 * The control plane has ONE store implementation, `PostgresStore`. With
 * `DATABASE_URL` set it talks to a durable Postgres; without one (dev / tests) it
 * is backed by an in-memory Postgres (pg-mem) so the same SQL/DDL runs ephemerally
 * — no second hand-mirrored store to keep in lockstep. `pg-mem` is imported
 * dynamically so a production process never loads it.
 */
export async function createStore(): Promise<MeshStore> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) return new PostgresStore(databaseUrl);
  const { createPgMemStore } = await import("./pg-mem-store.js");
  return createPgMemStore();
}
