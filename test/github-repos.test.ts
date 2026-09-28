import assert from "node:assert/strict";
import { discoverGithubRepos, listGithubUserRepos } from "../src/github-repos.js";

const calls: string[] = [];
const fetchImpl = (async (input, init) => {
  const url = new URL(String(input));
  calls.push(url.searchParams.get("page")!);
  assert.equal(url.pathname, "/user/repos");
  assert.equal(url.searchParams.get("affiliation"), "owner,collaborator,organization_member");
  assert.equal((init?.headers as Record<string, string>).authorization, "Bearer user-token");
  return Response.json(url.searchParams.get("page") === "1"
    ? Array.from({ length: 100 }, (_, i) => ({ full_name: `personal/repo-${i}` }))
    : [{ full_name: "bivysh/bivy", description: "Bivy", private: true, pushed_at: "2026-09-28", default_branch: "main" }, {}]);
}) as typeof fetch;
const userRepos = await listGithubUserRepos("user-token", fetchImpl);
assert.deepEqual(calls, ["1", "2"]);
assert.equal(userRepos.length, 101);
assert.deepEqual(userRepos[100], { slug: "bivysh/bivy", description: "Bivy", private: true, pushedAt: "2026-09-28", defaultBranch: "main" });
await assert.rejects(listGithubUserRepos("token", (async () => new Response("", { status: 401 })) as typeof fetch), /GitHub responded 401/);
await assert.rejects(listGithubUserRepos("token", (async () => Response.json({})) as typeof fetch), /invalid repository listing/);

const appRepo = { slug: "pettersj/janitor", description: "Bivy automation", private: true, defaultBranch: "trunk" };
const sources = {
  appRepos: async () => [appRepo],
  userRepos: async () => [...userRepos, { ...appRepo, slug: "PETTERSJ/JANITOR" }],
  ghInstalled: async () => { throw new Error("Do not probe gh when credentials are available"); },
};
const combined = await discoverGithubRepos(sources);
assert.equal(combined.authed, true);
assert.equal(combined.error, undefined);
assert.equal(combined.repos.length, 102);
assert.equal(combined.repos[0].slug, "bivysh/bivy");
assert.deepEqual(combined.repos.find(r => r.slug === appRepo.slug), appRepo);

const fail = async (): Promise<never> => { throw new Error("credential rejected"); };
for (const source of ["appRepos", "userRepos"] as const) {
  const partial = await discoverGithubRepos({ ...sources, [source]: fail });
  assert.equal(partial.authed, true);
  assert.ok(partial.repos.length > 0);
  assert.match(partial.error!, /credential rejected/);
}
const failed = await discoverGithubRepos({ ...sources, appRepos: fail, userRepos: fail });
assert.equal(failed.authed, false);
assert.deepEqual(failed.repos, []);
assert.match(failed.error!, /GitHub App:.*GitHub user:/);

for (const source of ["appRepos", "userRepos"] as const) {
  const only = await discoverGithubRepos({ ...sources, [source]: async () => undefined });
  assert.equal(only.authed, true);
  assert.ok(only.repos.length > 0);
  assert.equal(only.error, undefined);
}
const empty = await discoverGithubRepos({ ...sources, appRepos: async () => [], userRepos: async () => undefined });
assert.deepEqual(empty, { authed: true, repos: [] });
for (const installed of [true, false]) {
  const absent = await discoverGithubRepos({ appRepos: async () => undefined, userRepos: async () => undefined, ghInstalled: async () => installed });
  assert.deepEqual(absent, { authed: false, repos: [], reason: installed ? "gh-unauthed" : "no-token" });
}
console.log("ok combined GitHub discovery, pagination, deduplication, partial failures and missing credentials");
