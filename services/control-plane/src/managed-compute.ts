// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Managed compute lane. This is NOT a second provisioner: a managed launch is
// the exact same server-side ephemeral path as hosted BYO-cloud provisioning,
// with one difference — the provider credential comes from an OPERATOR-owned
// account (whoever runs this control plane: Bivy's own Fly org on bivy.sh, or
// your org on a self-hosted deployment) instead of the user's
// hosted.providerTokens. One provisioner, different token source.
//
// SECURITY: the operator token is used transiently at launch/teardown exactly
// like a user's hosted token — it is never baked into machine user-data, never
// persisted to the store, and never returned by any API.

/** Which credential lane an ephemeral config launches with. */
export type ComputeSource = "user" | "managed";

/** Absent/unknown → "user", so every pre-existing config keeps its behavior. */
export function normalizeComputeSource(value: unknown): ComputeSource {
  return value === "managed" ? "managed" : "user";
}

/**
 * Deployment kill switch for NEW managed launches. Default OFF — an operator
 * opts in with MANAGED_COMPUTE_ENABLED=1. Mirrors EPHEMERAL_MACHINES_ENABLED
 * semantics: it gates launches only, never cleanup — teardown, reconcile, and
 * orphan sweeps for already-created managed machines keep running while it is
 * off (the operator token stays available to them via the token source).
 */
export function managedComputeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MANAGED_COMPUTE_ENABLED === "1";
}

/**
 * Server-side source of operator-owned provider tokens. Deliberately an
 * interface so the env-backed implementation below can be replaced by a
 * KMS/secret-manager-backed one without touching any provisioner caller.
 */
export interface OperatorTokenSource {
  /** The operator token for `provider` (e.g. "fly"), or undefined when the
   * managed lane is not configured for that provider. */
  getToken(provider: string): Promise<string | undefined>;
}

/** Env-backed source: MANAGED_PROVIDER_TOKEN_<PROVIDER> (e.g.
 * MANAGED_PROVIDER_TOKEN_FLY). Read per call so rotation needs no restart-order
 * care in tests; a production deployment restarts on env change anyway. */
export function envOperatorTokenSource(env: NodeJS.ProcessEnv = process.env): OperatorTokenSource {
  return {
    async getToken(provider: string) {
      const suffix = String(provider || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
      if (!suffix) return undefined;
      const token = env[`MANAGED_PROVIDER_TOKEN_${suffix}`];
      return typeof token === "string" && token.trim() ? token.trim() : undefined;
    },
  };
}

/** The deployment's operator token source. Env-backed today; when a KMS-backed
 * source lands, swap the implementation HERE and every caller follows. */
export function operatorTokenSource(): OperatorTokenSource {
  return envOperatorTokenSource();
}
