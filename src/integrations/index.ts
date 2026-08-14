// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
export { IntegrationManager, type SessionIdRef } from "./manager.js";
export { BUILT_IN_INTEGRATIONS, ATTACH_TO_CHAT_TOOL } from "./registry.js";
export type {
  IntegrationDef,
  IntegrationToolDef,
  IntegrationAuthSpec,
  IntegrationPublic,
  IntegrationConnection,
  IntegrationHttp,
  StandaloneToolDef,
} from "./types.js";
