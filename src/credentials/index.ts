// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Public entry point for the standalone credential service.
//
// This is the ONE module the rest of Bivy should import from. Drawing the import
// through a single facade is what lets the service be lifted into its own package
// later without touching call sites. The service owns storage, the record model,
// selection, and (eventually) sync policy; it imports NOTHING from agents/,
// session/, or the control plane — those needs are inverted (passed in).
//
// Phase 1 (this PR) is additive: the new pure record model ships here, and the
// existing credential surface is re-exported so new code can already import from
// `src/credentials/`. Later phases move the implementations under this directory
// and wire selection into the live path. See docs/credentials-service-plan.md.

// --- The record model + selection (new, pure) ------------------------------
export {
  DEFAULT_LABEL,
  normalizeProvider,
  normalizeLabel,
  credKey,
  parseCredKey,
  agentNativeLabel,
  defaultSyncFor,
  inferReferenceBackend,
  resolveCredential,
  missingPresetLabels,
} from "./records.js";
export type {
  SyncPolicy,
  CredentialOrigin,
  CredentialSource,
  CredentialRecord,
  CredentialPresets,
  SelectionRequest,
  Selection,
  DanglingPreset,
} from "./records.js";

// --- The v3 document engine: schema, migration, merge (new, pure) -----------
export {
  emptyDocument,
  recordFromStored,
  preferIncomingRecord,
  tombstoneWinsRecord,
  migrateToV3,
  mergeDocuments,
} from "./document.js";
export type { CredentialVaultDocumentV3, MergeResult } from "./document.js";

// --- Selection presets + ingest policy (config-as-code) ---------------------
export {
  parsePresets,
  loadPresets,
  defaultPresetsPath,
  PRESETS_FILENAME,
  parseIngestPolicy,
  loadIngestPolicy,
} from "./presets.js";
export type { IngestPolicy } from "./presets.js";

// --- The vault (source of truth) — now in-layer -----------------------------
export {
  createCredentialVault,
  migrateVaultDir,
  preferIncomingCredential,
  tombstoneWins,
  BivyCredentialStore,
} from "./store.js";
export type { StoredCredential, ApiKeyCredential, OAuthCredential } from "./types.js";

// --- Injected capability ports (crypto, secret refs, OAuth refresh) ---------
// Contracts the vault/resolver depend on once they move into this layer.
export type { Sealer, SecretResolver, OAuthRefresher } from "./ports.js";
export type { StoredCredentialInfo, CredentialTombstones } from "./store.js";

// --- The node resolver + agent env representation ---------------------------
export {
  createCredentialStore,
  buildAgentCredentialEnv,
  apiKeyEnvVar,
  NodeCredentialResolver,
} from "../runtime/credentials.js";

// --- The daemon credential API (ours — Pi-free) -----------------------------
export {
  exportProviderAuth,
  exportProviderAuthTombstones,
  importProviderAuth,
  setProviderApiKey,
  setProviderCredential,
  setProviderReference,
  removeProvider,
  listCredentialRecords,
  setProviderApiKeyLabeled,
  setProviderReferenceLabeled,
  removeProviderCredential,
  joinProviderCatalog,
} from "./api.js";
export type { ProviderAuthInfo, CredentialRecordSummary, ProviderCatalogEntry } from "./api.js";

// --- The Pi-catalog bridge (the one Pi-coupled provider listing) ------------
export { listProviders } from "../runtime/provider-catalog.js";
