// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Compatibility shim + node composition root for the credential resolver.
//
// The resolver itself moved to src/credentials/resolver.ts (pilot step 4 — see
// docs/internal/platform-modularization-plan.md), where it depends on injected
// ports instead of secrets.ts and the Pi OAuth bridge. This module binds the
// node adapters for those ports and re-exposes the historical
// `createCredentialStore(credsDir)` signature, so every existing importer
// (server.ts, runtime/index.ts, agents, tests) is unchanged.

import path from "node:path";

import { resolveSecret } from "../secrets.js";
import { refreshModelOAuth } from "./oauth/model-oauth.js";
import {
  createCredentialStore as createResolver,
  NodeCredentialResolver,
  buildAgentCredentialEnv,
  apiKeyEnvVar,
} from "../credentials/resolver.js";
import type { SecretResolver, OAuthRefresher } from "../credentials/ports.js";
import type { AgentCredentialStore } from "../credentials/types.js";

export { NodeCredentialResolver, buildAgentCredentialEnv, apiKeyEnvVar };

/** Build the shared credential resolver, binding the node reference/OAuth adapters. */
export function createCredentialStore(credsDir: string): AgentCredentialStore {
  // The data dir that holds the local secret vault, for resolving `secret://`
  // references (`op://`/`env://` need no dir). credsDir is `<appDir>/credentials`.
  const appDir = path.dirname(credsDir);
  const secrets: SecretResolver = { resolve: (ref) => resolveSecret(ref, appDir) };
  const oauth: OAuthRefresher = {
    refresh: (provider, label) => refreshModelOAuth(credsDir, provider, label),
  };
  return createResolver(credsDir, secrets, oauth);
}
