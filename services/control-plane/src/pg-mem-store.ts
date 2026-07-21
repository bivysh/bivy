// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import type pg from "pg";
import { newDb } from "pg-mem";

import { PostgresStore } from "./postgres-store.js";

/**
 * A `PostgresStore` backed by an in-memory Postgres (`pg-mem`) instead of a live
 * database. This is the no-`DATABASE_URL` path — dev runs and the whole unit-test
 * suite exercise the SAME SQL/DDL as production, ephemerally, so there is no second
 * hand-mirrored store implementation to keep in lockstep (the retired `MemoryStore`).
 *
 * Each call builds a fresh, isolated in-memory schema. Callers must `await init()`
 * to create the tables, exactly like the durable path (`DDL is CREATE TABLE IF NOT
 * EXISTS`, so double-init is a harmless no-op). Not persistent: state lives only for
 * the life of the process, matching what `MemoryStore` used to provide.
 *
 * `pg-mem` is loaded here rather than in `store-factory`, and the factory imports
 * this module dynamically, so a production process (with `DATABASE_URL` set) never
 * loads `pg-mem` at all.
 */
export function createPgMemStore(): PostgresStore {
  const { Pool } = newDb().adapters.createPg();
  // pg-mem's Pool is structurally pg-compatible; PostgresStore only needs the pool
  // injection seam, so the cast is safe for the in-memory adapter.
  return new PostgresStore("", new Pool() as unknown as pg.Pool);
}
