// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Compatibility shim. The credential vault engine moved to
// src/credentials/store.ts as part of the credentials two-layer split. Existing
// importers of this path keep working via the re-exports below; new
// credentials-layer code imports from ../credentials/store.js directly. This
// shim can be removed once all importers are re-pointed.
export {
  BivyCredentialStore,
  createCredentialVault,
  migrateVaultDir,
  preferIncomingCredential,
  tombstoneWins,
} from "../credentials/store.js";
export type { StoredCredentialInfo, CredentialTombstones } from "../credentials/store.js";
export type { ApiKeyCredential, OAuthCredential, StoredCredential } from "../credentials/types.js";
// Re-exported for existing importers (e.g. test/credential-record-sync.test.ts)
// that reach CredentialRecord through this module's path.
export type { CredentialRecord } from "../credentials/records.js";
