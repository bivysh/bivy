// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { GithubRepository } from "./github-app-repos.js";

export interface RepoListing {
  authed: boolean;
  repos: GithubRepository[];
  error?: string;
  reason?: "no-token" | "gh-unauthed";
}

/** User credentials (configured token or gh login) can reach repos outside the Apps. */
export async function listGithubUserRepos(token: string, fetchImpl: typeof fetch = fetch): Promise<GithubRepository[]> {
  const repos: GithubRepository[] = [];
  for (let page = 1; ; page++) {
    const response = await fetchImpl(`https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member&page=${page}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "bivy" },
    });
    if (!response.ok) throw new Error(`GitHub responded ${response.status} while listing user repositories`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error("GitHub returned an invalid repository listing");
    for (const repo of batch) {
      if (typeof repo?.full_name !== "string" || !repo.full_name) continue;
      repos.push({
        slug: repo.full_name,
        description: typeof repo.description === "string" ? repo.description : "",
        private: Boolean(repo.private),
        pushedAt: typeof repo.pushed_at === "string" ? repo.pushed_at : undefined,
        defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : undefined,
      });
    }
    if (batch.length < 100) return repos;
  }
}

/** Query both sources independently; a failed credential must not hide usable repos. */
export async function discoverGithubRepos(sources: {
  appRepos(): Promise<GithubRepository[] | undefined>;
  userRepos(): Promise<GithubRepository[] | undefined>;
  ghInstalled(): Promise<boolean>;
}): Promise<RepoListing> {
  const results = await Promise.allSettled([sources.appRepos(), sources.userRepos()]);
  const repos = new Map<string, GithubRepository>();
  const errors: string[] = [];
  let authed = false;
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      errors.push(`${index === 0 ? "GitHub App" : "GitHub user"}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      continue;
    }
    if (result.value === undefined) continue;
    authed = true;
    for (const repo of result.value) {
      const key = repo.slug.toLowerCase();
      if (!repos.has(key)) repos.set(key, repo);
    }
  }
  const listing: RepoListing = {
    authed,
    repos: [...repos.values()].sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "") || a.slug.localeCompare(b.slug)),
  };
  if (errors.length) listing.error = errors.join("; ");
  else if (!authed) listing.reason = await sources.ghInstalled() ? "gh-unauthed" : "no-token";
  return listing;
}
