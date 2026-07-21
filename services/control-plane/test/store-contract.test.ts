// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { runStoreContract } from "./store-contract.js";
import { createPgMemStore } from "../src/pg-mem-store.js";

/**
 * Runs the shared `MeshStore` contract (test/store-contract.ts) against the REAL
 * PostgresStore — no live database — by backing it with pg-mem (an in-memory
 * Postgres). This exercises the actual Postgres SQL/DDL ephemerally; a fresh
 * in-memory schema per store instance gives per-test isolation, exactly like the
 * contract wants. There is now one store implementation, so this is the whole
 * behavioral guard (compile-time `implements MeshStore` still catches shape drift).
 */
const passed = await runStoreContract("postgres", () => createPgMemStore());

console.log(`\nAll ${passed} PostgresStore contract assertions passed.`);
