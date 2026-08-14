// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Compatibility facade. Provider interpreters live in ephemeral-providers/;
// registry composition and genuinely shared projections are separate modules.

import { ephemeralCostEstimate as deriveEphemeralCostEstimate } from "./ephemeral-lifecycle.js";
import type { ProviderSize } from "./ephemeral-provider-ports.js";

export type {
  BootstrapOpts,
  ExecFn,
  ExecRequest,
  ExecResult,
  ProviderAdapter,
  ProviderProvisionConfig,
  ProviderSize,
} from "./ephemeral-provider-ports.js";
export { buildBootstrapUserData } from "./ephemeral-provider-bootstrap.js";
export { ephemeralAdapter, validateEphemeralProviderToken } from "./ephemeral-provider-registry.js";
export { ALLOWED_HOSTS, assertAllowedUrl, extractProviderMessage } from "./ephemeral-provider-utils.js";
export { awsSign, parseAwsToken, parseXml, xmlChild, xmlChildren, xmlFind } from "./ephemeral-providers/aws.js";
export type { AwsCreds, XmlEl } from "./ephemeral-providers/aws.js";

/** Compatibility shell: callers may omit `nowMs` and read the clock here. */
export function ephemeralCostEstimate(
  size: ProviderSize | undefined,
  createdAt: string,
  ttlMinutes?: number,
  nowMs = Date.now(),
): { accrued: number; maximum: number } | null {
  return deriveEphemeralCostEstimate(size, createdAt, ttlMinutes, nowMs);
}
