// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Minting short-lived GitHub App installation tokens for hosted provisioning.
// Preferred over a stored long-lived PAT: an installation token is ~1h,
// repo-scoped, and minted on demand, so a compromised machine (or database)
// yields at most a short-lived, narrowly-scoped credential — and long agent
// sessions keep working because the machine re-fetches a fresh token per git
// operation from the mint-on-demand endpoint.
//
// The app private key is held (encrypted) on the control plane only for the
// hosted path; see docs/hosted-provisioning-trust-model.md.
import { createSign } from "node:crypto";

export interface GithubAppCreds {
  appId: string;
  installationId: string;
  privateKeyPem: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

export interface GithubInstallation {
  id: string;
  account: string;
  accountType?: string;
}

export interface GithubRepository {
  slug: string;
  description?: string;
  private?: boolean;
  defaultBranch?: string;
}

export interface GithubBranch {
  name: string;
}

const githubHeaders = (authorization: string) => ({
  authorization,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "bivy-control-plane",
});

/** GitHub API base — overridable for GitHub Enterprise and for tests that run
 *  a local stand-in API. Read per call so a test can set it after import. */
function githubApiBase(): string {
  return (process.env.GITHUB_API_BASE_URL || "https://api.github.com").replace(/\/$/, "");
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RS256 app JWT: iat backdated 30s for clock skew, 9-minute expiry (< GitHub's 10m cap). */
export function createAppJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSec - 30, exp: nowSec + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = b64url(signer.sign(privateKeyPem));
  return `${signingInput}.${signature}`;
}

/** Exchange the app JWT for a ~1h installation access token. When
 *  `opts.repositories` names repos (bare names, no owner), the token is scoped
 *  down to just those — GitHub rejects names outside the installation, so
 *  callers that scope should be prepared to retry unscoped. */
export async function mintInstallationToken(
  creds: GithubAppCreds,
  fetchImpl: typeof fetch = fetch,
  nowSec = Math.floor(Date.now() / 1000),
  opts?: { repositories?: string[] },
): Promise<InstallationToken> {
  const jwt = createAppJwt(creds.appId, creds.privateKeyPem, nowSec);
  const scoped = opts?.repositories?.length ? { repositories: opts.repositories } : undefined;
  const res = await fetchImpl(`${githubApiBase()}/app/installations/${encodeURIComponent(creds.installationId)}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "bivy-control-plane",
      ...(scoped ? { "content-type": "application/json" } : {}),
    },
    ...(scoped ? { body: JSON.stringify(scoped) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { token?: string; expires_at?: string; message?: string };
  if (!res.ok || !data.token) {
    throw new Error(`GitHub installation-token mint failed (${res.status}): ${data.message ?? "unknown error"}`);
  }
  return { token: data.token, expiresAt: data.expires_at ?? "" };
}

/** Validate an App id/key pair and enumerate the accounts it is installed on. */
export async function listAppInstallations(
  appId: string,
  privateKeyPem: string,
  fetchImpl: typeof fetch = fetch,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<GithubInstallation[]> {
  const jwt = createAppJwt(appId, privateKeyPem, nowSec);
  const installations: GithubInstallation[] = [];
  for (let page = 1; ; page += 1) {
    const res = await fetchImpl(`${githubApiBase()}/app/installations?per_page=100&page=${page}`, {
      headers: githubHeaders(`Bearer ${jwt}`),
    });
    const data = (await res.json().catch(() => ([]))) as Array<{
      id?: number | string;
      account?: { login?: string; type?: string };
    }> & { message?: string };
    if (!res.ok || !Array.isArray(data)) {
      throw new Error(`GitHub App validation failed (${res.status}): ${(data as { message?: string }).message ?? "unknown error"}`);
    }
    for (const item of data) {
      if (item.id == null || !item.account?.login) continue;
      installations.push({ id: String(item.id), account: item.account.login, accountType: item.account.type });
    }
    if (data.length < 100) break;
  }
  return installations;
}

export interface GithubInstallationDetail {
  id: string;
  account?: string;
  accountId?: string;
  accountType?: string;
  repositorySelection?: string;
}

/** One installation's metadata (owner login, repo selection), via the app JWT.
 *  Used by the central-app setup callback to record which GitHub org/user an
 *  installation covers — a 404 here also proves the id does NOT belong to the
 *  app, so a forged installation_id can never be bound. */
export async function getAppInstallation(
  appId: string,
  privateKeyPem: string,
  installationId: string,
  fetchImpl: typeof fetch = fetch,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<GithubInstallationDetail> {
  const jwt = createAppJwt(appId, privateKeyPem, nowSec);
  const res = await fetchImpl(`${githubApiBase()}/app/installations/${encodeURIComponent(installationId)}`, {
    headers: githubHeaders(`Bearer ${jwt}`),
  });
  const data = (await res.json().catch(() => ({}))) as {
    id?: number | string;
    account?: { id?: number | string; login?: string; type?: string };
    repository_selection?: string;
    message?: string;
  };
  if (!res.ok || data.id == null) {
    throw new Error(`GitHub installation lookup failed (${res.status}): ${data.message ?? "unknown error"}`);
  }
  return {
    id: String(data.id),
    account: data.account?.login,
    accountId: data.account?.id == null ? undefined : String(data.account.id),
    accountType: data.account?.type,
    repositorySelection: typeof data.repository_selection === "string" ? data.repository_selection : undefined,
  };
}

/** Repositories visible to one installation, using only an on-demand token. */
export async function listInstallationRepositories(
  creds: GithubAppCreds,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubRepository[]> {
  const { token } = await mintInstallationToken(creds, fetchImpl);
  const repositories: GithubRepository[] = [];
  for (let page = 1; ; page += 1) {
    const res = await fetchImpl(`${githubApiBase()}/installation/repositories?per_page=100&page=${page}`, {
      headers: githubHeaders(`Bearer ${token}`),
    });
    const data = (await res.json().catch(() => ({}))) as {
      repositories?: Array<{ full_name?: string; description?: string | null; private?: boolean; default_branch?: string }>;
      message?: string;
    };
    if (!res.ok || !Array.isArray(data.repositories)) {
      throw new Error(`GitHub repository listing failed (${res.status}): ${data.message ?? "unknown error"}`);
    }
    for (const repo of data.repositories) {
      if (!repo.full_name) continue;
      repositories.push({
        slug: repo.full_name,
        ...(repo.description ? { description: repo.description } : {}),
        ...(typeof repo.private === "boolean" ? { private: repo.private } : {}),
        ...(repo.default_branch ? { defaultBranch: repo.default_branch } : {}),
      });
    }
    if (data.repositories.length < 100) break;
  }
  return repositories;
}

/** Branches of one installation-owned repository. The minted token is narrowed
 * to this repository and never returned to the browser. */
export async function listInstallationBranches(
  creds: GithubAppCreds,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubBranch[]> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error("Repository must be owner/name");
  const { token } = await mintInstallationToken(creds, fetchImpl, undefined, { repositories: [name] });
  const branches: GithubBranch[] = [];
  for (let page = 1; ; page += 1) {
    const res = await fetchImpl(`${githubApiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches?per_page=100&page=${page}`, {
      headers: githubHeaders(`Bearer ${token}`),
    });
    const data = (await res.json().catch(() => [])) as Array<{ name?: string }> | { message?: string };
    if (!res.ok || !Array.isArray(data)) {
      const message = !Array.isArray(data) && typeof data.message === "string" ? data.message : "unknown error";
      throw new Error(`GitHub branch listing failed (${res.status}): ${message}`);
    }
    for (const branch of data) if (branch.name) branches.push({ name: branch.name });
    if (data.length < 100) break;
  }
  return branches;
}
