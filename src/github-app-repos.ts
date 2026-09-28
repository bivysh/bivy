// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { createAppJwt, type GitHubAppConfig } from "./github-app-auth.js";

export interface GithubRepository {
  slug: string;
  description: string;
  private: boolean;
  pushedAt?: string;
  defaultBranch?: string;
}

/** App credentials cannot call /user/repos. Enumerate each installation instead. */
export async function listGithubAppRepos(
  apps: { cfg: GitHubAppConfig; cache: { get(id: string): Promise<string> } }[],
  fetchImpl: typeof fetch = fetch,
): Promise<GithubRepository[]> {
  const repos = new Map<string, GithubRepository>();
  async function pages(path: string, token: string, field?: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (let page = 1; ; page++) {
      const res = await fetchImpl(`https://api.github.com${path}?per_page=100&page=${page}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "bivy" },
      });
      if (!res.ok) throw new Error(`GitHub responded ${res.status} while listing repositories`);
      const body = await res.json();
      const batch = field ? body[field] : body;
      if (!Array.isArray(batch)) throw new Error("GitHub returned an invalid repository listing");
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
  }
  for (const app of apps) {
    const jwt = createAppJwt(app.cfg.appId, app.cfg.privateKeyPem, Math.floor(Date.now() / 1000));
    for (const installation of await pages("/app/installations", jwt)) {
      if (installation.suspended_at) continue;
      const token = await app.cache.get(String(installation.id));
      for (const repo of await pages("/installation/repositories", token, "repositories")) {
        if (typeof repo.full_name !== "string" || !repo.full_name) continue;
        repos.set(repo.full_name.toLowerCase(), {
          slug: repo.full_name,
          description: typeof repo.description === "string" ? repo.description : "",
          private: Boolean(repo.private),
          pushedAt: typeof repo.pushed_at === "string" ? repo.pushed_at : undefined,
          defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : undefined,
        });
      }
    }
  }
  return [...repos.values()].sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "") || a.slug.localeCompare(b.slug));
}
