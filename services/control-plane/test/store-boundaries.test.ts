// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const storeSource = await readFile(join(src, "store.ts"), "utf8");

assert.equal(
  storeSource.includes("MeshStore"),
  false,
  "the monolithic MeshStore surface must not be reintroduced",
);

const repositoryNames = [
  "AccountAuthRepository",
  "BillingRepository",
  "NodeRepository",
  "SessionIndexRepository",
  "NotificationRepository",
  "EphemeralConfigurationRepository",
  "HostedMachineRepository",
  "VaultRepository",
  "SessionStateRepository",
  "GithubAppVaultRepository",
  "InboundHookRepository",
  "AutomationRepository",
  "WorkQueueRepository",
];
for (const name of repositoryNames) {
  assert.match(storeSource, new RegExp(`export interface ${name} \\{`), `${name} must remain an explicit capability port`);
}

const sourceFiles = (await readdir(src)).filter((name) => name.endsWith(".ts"));
for (const name of sourceFiles) {
  if (["store.ts", "postgres-store.ts", "store-factory.ts"].includes(name)) continue;
  const source = await readFile(join(src, name), "utf8");
  assert.doesNotMatch(
    source,
    /\bControlPlaneStore\b/,
    `${name} is a consumer and must depend on narrow repository ports, not the aggregate store`,
  );
}

const adapterSource = await readFile(join(src, "postgres-store.ts"), "utf8");
assert.match(
  adapterSource,
  /class PostgresStore implements ControlPlaneStore/,
  "the one Postgres adapter must compose every repository capability",
);
assert.doesNotMatch(adapterSource, /this\.pool|query\("BEGIN"\)/, "repositories must use the explicit database/transaction context");

const databaseSource = await readFile(join(src, "postgres-database.ts"), "utf8");
assert.match(databaseSource, /export class PostgresDatabaseContext/, "Postgres pool ownership must stay explicit");
assert.match(databaseSource, /export interface PostgresTransactionContext/, "transaction lifetime must stay explicit");

console.log("store architecture boundary checks passed");
