// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** Serializable event shape at the pure catalog/settings boundary. */
export type CatalogSettingsEventData = Readonly<Record<string, unknown>> & { type?: unknown };

export interface CatalogSettingsFoldResult {
  handled: boolean;
  catalogs?: Readonly<Record<string, unknown>>;
  settings?: Readonly<Record<string, unknown>>;
}

/**
 * Fold list/snapshot events into explicit value patches. Validation stays at
 * this boundary; the identity shell only installs a returned immutable patch.
 */
export function foldCatalogSettingsEvent(event: CatalogSettingsEventData): CatalogSettingsFoldResult {
  switch (event.type) {
    case "repos.list":
      return { handled: true, catalogs: {
        repos: Array.isArray(event.repos) ? event.repos : [],
        reposAuthed: event.authed !== false,
        reposError: event.error || null,
        reposReason: event.reason === "gh-unauthed" || event.reason === "no-token" ? event.reason : null,
        reposLoading: false,
      } };
    case "branches.list":
      return { handled: true, catalogs: {
        branches: Array.isArray(event.branches) ? event.branches : [],
        branchesRepo: typeof event.repo === "string" && event.repo ? event.repo : null,
        branchesDefault: typeof event.defaultBranch === "string" ? event.defaultBranch : null,
        branchesError: event.error || null,
        branchesLoading: false,
      } };
    case "credentials.records":
      return { handled: true, settings: { credentialRecords: Array.isArray(event.records) ? event.records : [] } };
    case "credentials.presets":
      return { handled: true, settings: { credentialPresets: event.presets ?? {} } };
    case "models.custom.list":
      return Array.isArray(event.providers)
        ? { handled: true, settings: { localModels: event.providers } }
        : { handled: true };
    case "models.custom.presets":
      return Array.isArray(event.presets)
        ? { handled: true, settings: { localModelPresets: event.presets } }
        : { handled: true };
    case "rulesets.list":
      return Array.isArray(event.rulesets)
        ? { handled: true, settings: { rulesets: event.rulesets } }
        : { handled: true };
    case "stt.config":
      return Array.isArray(event.providers) && typeof event.provider === "string"
        ? { handled: true, settings: { sttConfig: { provider: event.provider, providers: event.providers } } }
        : { handled: true };
    case "node.settings":
      return event.settings && typeof event.settings === "object"
        ? { handled: true, settings: { nodeSettings: event.settings } }
        : { handled: true };
    default:
      return { handled: false };
  }
}
