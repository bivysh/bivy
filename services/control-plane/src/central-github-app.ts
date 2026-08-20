// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The ONE centrally-owned GitHub App (managed tier). Users click "Install" on
// this app and pick repos instead of creating their own app or pasting a PAT;
// the control plane then mints short-lived, repo-scoped installation tokens on
// demand (see docs/hosted-provisioning-trust-model.md).
//
// Two things live here:
//   1. Operator-level env config for the central app. Absent config = the
//      feature is cleanly off; a self-hoster registers their own app and sets
//      the same variables.
//   2. The per-account GitHub identity-mode RESOLUTION TABLE: mode → credential
//      source. Every consumer (mint-on-demand, launch injection) goes through
//      `resolveGithubIdentity` — adding a mode means adding a row, not an `if`.
import type {
  CentralGithubInstallation,
  GithubIdentityMode,
  HostedAuditEvent,
  HostedProvisioning,
} from "./store.js";

export interface CentralGithubAppConfig {
  appId: string;
  privateKeyPem: string;
  /** Verifies deliveries to POST /webhooks/central-github. */
  webhookSecret?: string;
  /** App slug — builds github.com/apps/<slug>/installations/new install links
   *  and doubles as the default `@`-mention handle. */
  slug?: string;
}

// PEM pasted directly (possibly with literal \n escapes from an env file), or
// base64 of the whole PEM — the friendlier form for single-line env vars.
function decodePrivateKeyPem(raw: string): string | null {
  if (raw.includes("-----BEGIN")) return raw.replace(/\\n/g, "\n");
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  return decoded.includes("-----BEGIN") ? decoded : null;
}

/**
 * The central GitHub App, from operator env config. Returns null (feature off)
 * unless both the app id and a decodable private key are present:
 *
 *   BIVY_CENTRAL_GITHUB_APP_ID              numeric app id
 *   BIVY_CENTRAL_GITHUB_APP_PRIVATE_KEY     PEM (or base64 of the PEM)
 *   BIVY_CENTRAL_GITHUB_APP_WEBHOOK_SECRET  verifies /webhooks/central-github
 *   BIVY_CENTRAL_GITHUB_APP_SLUG            app slug, for install links
 */
export function centralGithubAppConfig(env: NodeJS.ProcessEnv = process.env): CentralGithubAppConfig | null {
  const appId = (env.BIVY_CENTRAL_GITHUB_APP_ID || "").trim();
  const rawKey = (env.BIVY_CENTRAL_GITHUB_APP_PRIVATE_KEY || "").trim();
  if (!appId || !rawKey) return null;
  const privateKeyPem = decodePrivateKeyPem(rawKey);
  if (!privateKeyPem) return null;
  const webhookSecret = (env.BIVY_CENTRAL_GITHUB_APP_WEBHOOK_SECRET || "").trim() || undefined;
  const slug = (env.BIVY_CENTRAL_GITHUB_APP_SLUG || "").trim() || undefined;
  return {
    appId,
    privateKeyPem,
    ...(webhookSecret ? { webhookSecret } : {}),
    ...(slug ? { slug } : {}),
  };
}

/** The public "Install" link, carrying the account-binding state nonce. */
export function centralInstallUrl(config: CentralGithubAppConfig, state: string): string | undefined {
  if (!config.slug) return undefined;
  return `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

// ---------------------------------------------------------------------------
// Identity-mode resolution
// ---------------------------------------------------------------------------

export interface GithubIdentitySources {
  hosted: Pick<HostedProvisioning, "githubIdentity" | "githubApp" | "githubToken">;
  central: CentralGithubAppConfig | null;
  /** Central-app installations bound to THIS account (already account-filtered
   *  by the store lookup — that filtering is the cross-account isolation). */
  centralInstallations: CentralGithubInstallation[];
}

export type ResolvedGithubIdentity =
  | { mode: "central-app" | "own-app"; kind: "app"; appId: string; installationId: string; privateKeyPem: string }
  | { mode: "token"; kind: "token"; token: string };

/**
 * The installation to mint from: the one whose GitHub org/user owns the repo
 * when we know it, else the account's only installation, else the earliest
 * bound one (stable across calls).
 */
export function pickCentralInstallation(
  installations: CentralGithubInstallation[],
  repo?: string,
): CentralGithubInstallation | undefined {
  if (!installations.length) return undefined;
  const owner = repo?.includes("/") ? repo.split("/")[0]!.toLowerCase() : undefined;
  if (owner) {
    const match = installations.find((i) => i.githubAccount?.toLowerCase() === owner);
    if (match) return match;
  }
  if (installations.length === 1) return installations[0];
  return [...installations].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

// THE resolution table: identity mode → credential source. One row per mode.
const IDENTITY_RESOLUTION: Record<
  GithubIdentityMode,
  (sources: GithubIdentitySources, repo?: string) => ResolvedGithubIdentity | null
> = {
  "central-app": (s, repo) => {
    if (!s.central) return null;
    const installation = pickCentralInstallation(s.centralInstallations, repo);
    if (!installation) return null;
    return {
      mode: "central-app",
      kind: "app",
      appId: s.central.appId,
      installationId: installation.installationId,
      privateKeyPem: s.central.privateKeyPem,
    };
  },
  "own-app": (s) =>
    s.hosted.githubApp
      ? {
          mode: "own-app",
          kind: "app",
          appId: s.hosted.githubApp.appId,
          installationId: s.hosted.githubApp.installationId,
          privateKeyPem: s.hosted.githubApp.privateKeyPem,
        }
      : null,
  token: (s) => (s.hosted.githubToken ? { mode: "token", kind: "token", token: s.hosted.githubToken } : null),
};

/** Unset mode = the pre-central behavior (own app, then PAT), with the central
 *  app as a final fallback so a plain install works without touching settings. */
const DEFAULT_IDENTITY_ORDER: readonly GithubIdentityMode[] = ["own-app", "token", "central-app"];

/**
 * Resolve the account's GitHub identity to a concrete credential source. An
 * explicitly chosen mode resolves through its row only (a misconfigured choice
 * yields null rather than silently using another identity); unset falls
 * through `DEFAULT_IDENTITY_ORDER`.
 */
export function resolveGithubIdentity(sources: GithubIdentitySources, repo?: string): ResolvedGithubIdentity | null {
  const order: readonly GithubIdentityMode[] = sources.hosted.githubIdentity
    ? [sources.hosted.githubIdentity]
    : DEFAULT_IDENTITY_ORDER;
  for (const mode of order) {
    const resolved = IDENTITY_RESOLUTION[mode](sources, repo);
    if (resolved) return resolved;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Installation lifecycle webhook events
// ---------------------------------------------------------------------------

/** The slice of the store the installation-event handler needs. */
export interface CentralInstallationStorePort {
  getCentralGithubInstallation(installationId: string): Promise<CentralGithubInstallation | undefined>;
  putCentralGithubInstallation(input: {
    installationId: string;
    accountId: string;
    githubAccount?: string;
    githubAccountType?: string;
    repositorySelection?: string;
  }): Promise<CentralGithubInstallation>;
  deleteCentralGithubInstallation(installationId: string, accountId?: string): Promise<boolean>;
  appendHostedAudit(accountId: string, event: HostedAuditEvent): Promise<void>;
}

export interface CentralInstallationEventResult {
  /** True when the event was an installation lifecycle event (fully handled). */
  handled: boolean;
  action?: "unbound" | "updated" | "removed" | "ignored";
  accountId?: string;
}

interface InstallationEventPayload {
  action?: string;
  installation?: {
    id?: number | string;
    account?: { login?: string; type?: string };
    repository_selection?: string;
  };
}

export function parseInstallationMeta(payload: unknown): {
  installationId?: string;
  githubAccount?: string;
  githubAccountType?: string;
  repositorySelection?: string;
} {
  const installation = (payload as InstallationEventPayload | undefined)?.installation;
  if (!installation || typeof installation !== "object") return {};
  return {
    installationId: installation.id != null ? String(installation.id) : undefined,
    githubAccount: typeof installation.account?.login === "string" ? installation.account.login : undefined,
    githubAccountType: typeof installation.account?.type === "string" ? installation.account.type : undefined,
    repositorySelection:
      typeof installation.repository_selection === "string" ? installation.repository_selection : undefined,
  };
}

/**
 * Keep central-installation bindings in sync from the app's `installation` /
 * `installation_repositories` webhook events. Only already-bound installations
 * are touched: a bare `installation.created` carries no proof of WHICH Bivy
 * account installed the app — that proof is the state-signed setup callback —
 * so an unbound installation is deliberately left unrecorded here.
 */
export async function applyCentralInstallationEvent(
  store: CentralInstallationStorePort,
  event: string,
  payload: unknown,
): Promise<CentralInstallationEventResult> {
  if (event !== "installation" && event !== "installation_repositories") return { handled: false };
  const meta = parseInstallationMeta(payload);
  if (!meta.installationId) return { handled: true, action: "ignored" };
  const existing = await store.getCentralGithubInstallation(meta.installationId);
  if (!existing) return { handled: true, action: "unbound" };
  const action = String((payload as InstallationEventPayload | undefined)?.action ?? "");
  const at = new Date().toISOString();
  if (event === "installation" && action === "deleted") {
    await store.deleteCentralGithubInstallation(meta.installationId);
    await store.appendHostedAudit(existing.accountId, {
      at,
      action: "central_install_unbound",
      detail: `installation ${meta.installationId} uninstalled on GitHub`,
    });
    return { handled: true, action: "removed", accountId: existing.accountId };
  }
  await store.putCentralGithubInstallation({
    installationId: meta.installationId,
    accountId: existing.accountId,
    githubAccount: meta.githubAccount ?? existing.githubAccount,
    githubAccountType: meta.githubAccountType ?? existing.githubAccountType,
    repositorySelection: meta.repositorySelection ?? existing.repositorySelection,
  });
  await store.appendHostedAudit(existing.accountId, {
    at,
    action: "central_install_updated",
    detail: `installation ${meta.installationId} ${event}:${action || "updated"}`,
  });
  return { handled: true, action: "updated", accountId: existing.accountId };
}
