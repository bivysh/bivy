// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Common host-side contract for every agent integration.
 *
 * An integration connects Bivy to an agent the operator already uses. Most are
 * declarative process/ACP profiles; an integration that needs custom translation
 * may put that logic in an out-of-process bridge. The registry does not know or
 * branch on either implementation style.
 */
export type AgentIntegrationOrigin =
  | {
      kind: "package";
      packageId: string;
      packageVersion: string;
      publisher?: string;
      /** Where the integration package was obtained; not an execution privilege. */
      location: "distribution" | "installed";
      /** Verification is provenance metadata, never permission to bypass policy. */
      verified: boolean;
    }
  | { kind: "config" };

export function describeAgentIntegrationOrigin(origin: AgentIntegrationOrigin): string {
  if (origin.kind === "config") return "node configuration";
  return origin.location === "installed" ? `plugin ${origin.packageId}` : `${origin.packageId} integration package`;
}

export interface AgentIntegration<TInfo, TCreateOptions, TRuntime, TInstall = unknown> {
  id: string;
  aliases?: string[];
  visible: boolean;
  origin: AgentIntegrationOrigin;
  describe(): TInfo;
  create?: (options: TCreateOptions) => TRuntime;
  install?: (prefix: string) => TInstall | undefined;
}

/** Preserve inference while making each agent module satisfy the common contract. */
export function defineAgentIntegration<TInfo, TCreateOptions, TRuntime, TInstall = unknown>(
  integration: AgentIntegration<TInfo, TCreateOptions, TRuntime, TInstall>,
): AgentIntegration<TInfo, TCreateOptions, TRuntime, TInstall> {
  return integration;
}
