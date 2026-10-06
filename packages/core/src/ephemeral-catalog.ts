// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Pure provider identity, positioning, and lifecycle capability facts.
// This leaf intentionally has no imports or runtime dependencies.

export interface EphemeralProviderCatalog {
  id: string;
  name: string;
  /** Runtime/positioning boundary, shared by every onboarding surface: "byo-cloud"
   * machines run in the user's own cloud account at provider cost (no markup);
   * "managed-compute" runs on someone else's platform. */
  computeClass: "byo-cloud" | "managed-compute";
  tokenLabel: string;
  blurb: string;
  steps: readonly string[];
  links: readonly { label: string; url: string }[];
  /** Mirrors the adapter's `guestCanEnsureDeletion === false`: this provider's
   * guest shutdown does not stop billing, so a device-only (browser-held
   * token) launch is refused outright — only hosted/control-plane
   * provisioning (which retains independent deletion authority) can launch
   * it. Onboarding surfaces should say so up front rather than let the user
   * connect a token and hit the launch-time refusal cold. */
  hostedOnly?: boolean;
}

export const EPHEMERAL_PROVIDERS: readonly EphemeralProviderCatalog[] = [
  {
    id: "fly",
    name: "Fly.io",
    computeClass: "byo-cloud",
    tokenLabel: "Fly.io access token",
    blurb: "Bivy creates a temporary Fly Machine, runs the session, then destroys it.",
    steps: [
      "Open your Fly.io access tokens and sign in.",
      "Click Create token — use a short-lived/deploy token if your account offers one.",
      "Copy the token and paste it below. Revoke it after the session if you like.",
    ],
    links: [
      { label: "Create a Fly.io token", url: "https://fly.io/user/personal_access_tokens" },
      { label: "Fly Machines docs", url: "https://fly.io/docs/machines/" },
    ],
  },
];

export function ephemeralCatalogEntry(id: string): EphemeralProviderCatalog | null {
  const key = String(id || "").trim().toLowerCase();
  return EPHEMERAL_PROVIDERS.find((provider) => provider.id === key) || null;
}
