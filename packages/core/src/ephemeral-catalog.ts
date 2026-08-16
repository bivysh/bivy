// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Pure provider identity, positioning, and lifecycle capability facts.
// This leaf intentionally has no imports or runtime dependencies.

export interface EphemeralProviderCatalog {
  id: string;
  name: string;
  /** Strategic/runtime boundary, shared by every onboarding surface. Managed
   * compute is useful but is not evidence for Bivy's no-markup BYO-cloud moat. */
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
  {
    id: "hetzner",
    name: "Hetzner Cloud",
    computeClass: "byo-cloud",
    tokenLabel: "Hetzner Cloud API token",
    blurb: "Bivy manages Hetzner servers from start to deletion so billing always stops, even when your devices are offline.",
    steps: [
      "Open the Hetzner Cloud Console and select or create a project for Bivy's runners.",
      "Go to Security → API Tokens and click Generate API token.",
      "Choose Read & Write, then copy the token and paste it below.",
    ],
    links: [
      { label: "Hetzner Cloud Console", url: "https://console.hetzner.cloud/projects" },
      { label: "API token docs", url: "https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/" },
    ],
    hostedOnly: true,
  },
  {
    id: "aws",
    name: "AWS EC2",
    computeClass: "byo-cloud",
    tokenLabel: "Access key — paste as accessKeyId:secretAccessKey",
    blurb: "Bivy launches a temporary EC2 instance, runs the session, then terminates it.",
    steps: [
      "Create (or reuse) an IAM user scoped to a minimal EC2 policy — see the Bivy docs link below for a copy-pasteable policy.",
      "On that user, open Security credentials → Access keys → Create access key.",
      "Paste both values below as accessKeyId:secretAccessKey (append :sessionToken if you're using temporary STS credentials).",
    ],
    links: [
      { label: "IAM access keys", url: "https://console.aws.amazon.com/iam/home#/security_credentials" },
      { label: "EC2 console", url: "https://console.aws.amazon.com/ec2/home" },
      { label: "Minimal IAM policy (Bivy docs)", url: "https://github.com/bivysh/bivy/blob/main/docs/ephemeral-sessions.md#aws-ec2" },
    ],
  },
];

export function ephemeralCatalogEntry(id: string): EphemeralProviderCatalog | null {
  const key = String(id || "").trim().toLowerCase();
  return EPHEMERAL_PROVIDERS.find((provider) => provider.id === key) || null;
}
