// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Hosted endpoint defaults — single source of truth (step 1).
 *
 * The node derives its app/control-plane, relay, and remote-client URLs from ONE
 * hosted domain, so a user never has to type or even know these URLs. Every
 * value is overridable by environment variable for self-hosting / staging:
 *
 *   BIVY_HOSTED_DOMAIN      base domain (e.g. "bivy.sh")
 *   BIVY_CONTROL_PLANE_URL  full app/control-plane URL override
 *   BIVY_RELAY_URL          full relay ws(s):// URL override
 *   BIVY_CLIENT_BASE_URL    remote web-client base URL override
 *
 * Imported by both bin/bivy.mjs (plain Node) and src/relay-setup.ts (via tsx),
 * which is why this is a dependency-free .mjs module.
 */

// The hosted domain baked into builds. app.<domain> and relay.<domain> are
// derived from it so users do not need to enter hosted URLs during setup.
export const DEFAULT_HOSTED_DOMAIN = "bivy.sh";

/**
 * Resolve the hosted endpoints from env (falling back to the baked-in domain).
 * @param {Record<string, string | undefined>} [env]
 */
export function hostedEndpoints(env = process.env) {
  const domain = (env.BIVY_HOSTED_DOMAIN || DEFAULT_HOSTED_DOMAIN)
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const controlPlane = (env.BIVY_CONTROL_PLANE_URL || `https://app.${domain}`).replace(/\/+$/, "");
  const relay = (env.BIVY_RELAY_URL || `wss://relay.${domain}`).replace(/\/+$/, "");
  const clientBaseUrl = (env.BIVY_CLIENT_BASE_URL || controlPlane).replace(/\/+$/, "");
  return { domain, controlPlane, relay, clientBaseUrl };
}
