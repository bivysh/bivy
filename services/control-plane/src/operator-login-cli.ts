// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Run with docker compose exec, never from the HTTP server. Docker administrative
// access already grants access to the database and all account sessions.
import { PostgresStore } from "./postgres-store.js";
import { operatorLoginLink } from "./operator-login.js";

if (!process.env.DATABASE_URL) throw new Error("Operator login requires a durable DATABASE_URL.");
const store = new PostgresStore(process.env.DATABASE_URL);
try {
  // The running service has already initialized the schema. Do not run DDL from
  // a recovery command or create a second, in-memory account store.
  const link = await operatorLoginLink(store, process.env.SELF_HOST_OWNER_EMAIL ?? "", process.env.PUBLIC_CONTROL_PLANE_URL ?? "");
  console.log("Private owner sign-in link (single-use, expires in 15 minutes):");
  console.log(link);
  console.log("Keep this link private. For another login, rerun the server's login command.");
} finally {
  await store.close();
}
