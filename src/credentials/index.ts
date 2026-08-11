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

// --- The vault (source of truth) — re-exported from its current home --------
export {
  createCredentialVault,
  migrateVaultDir,
  preferIncomingCredential,
  tombstoneWins,
  BivyCredentialStore,
} from "../runtime/credential-store.js";
export type {
  StoredCredential,
  ApiKeyCredential,
  OAuthCredential,
  StoredCredentialInfo,
  CredentialTombstones,
} from "../runtime/credential-store.js";

// --- The node resolver + agent env representation ---------------------------
export {
  createCredentialStore,
  buildAgentCredentialEnv,
  apiKeyEnvVar,
  NodeCredentialResolver,
} from "../runtime/credentials.js";

// --- The daemon credential API (ours — currently named pi-auth.ts) ----------
// Phase 5 renames the file to `src/credentials/api.ts`; the facade keeps the
// import path stable so call sites don't churn when it moves.
export {
  listProviders,
  exportProviderAuth,
  exportProviderAuthTombstones,
  importProviderAuth,
  setProviderApiKey,
  setProviderCredential,
  removeProvider,
} from "../runtime/pi-auth.js";
export type { ProviderAuthInfo } from "../runtime/pi-auth.js";
