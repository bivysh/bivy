// SPDX-License-Identifier: FSL-1.1-ALv2
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
