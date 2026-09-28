import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { listGithubAppRepos } from "../src/github-app-repos.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const cfg = { appId: "42", privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
const requested: string[] = [];
const app = { cfg, cache: { async get(id: string) { requested.push(id); return `token-${id}`; } } };
const calls: string[] = [];
const fetchImpl = (async (input, init) => {
  const url = new URL(String(input));
  calls.push(url.pathname + url.search);
  const page = Number(url.searchParams.get("page"));
  const auth = (init?.headers as Record<string, string>).authorization;
  if (url.pathname === "/app/installations") {
    assert.match(auth, /^Bearer ey/);
    return Response.json(page === 1
      ? Array.from({ length: 100 }, (_, i) => ({ id: i, suspended_at: i === 0 ? null : "yesterday" }))
      : [{ id: 100 }]);
  }
  assert.equal(url.pathname, "/installation/repositories");
  assert.ok(["Bearer token-0", "Bearer token-100"].includes(auth));
  return Response.json({ repositories: page === 1
    ? Array.from({ length: 100 }, () => ({ full_name: "org/repo", private: true, description: "Repo", default_branch: "trunk" }))
    : [{ full_name: "org/other", pushed_at: "2026-01-01" }] });
}) as typeof fetch;
const repos = await listGithubAppRepos([app], fetchImpl);
assert.deepEqual(requested, ["0", "100"], "skip suspended installations");
assert.equal(calls.length, 6, "paginate installations and repositories");
assert.deepEqual(repos.map((repo) => repo.slug), ["org/other", "org/repo"], "deduplicate and sort repositories");
assert.equal(repos[1].defaultBranch, "trunk");
assert.equal(repos[1].private, true);
assert.equal(repos[1].description, "Repo");
await assert.rejects(listGithubAppRepos([app], (async () => new Response("", { status: 403 })) as typeof fetch), /GitHub responded 403/);
assert.deepEqual(await listGithubAppRepos([app], (async () => Response.json([])) as typeof fetch), []);
console.log("ok GitHub App repository discovery, pagination, suspended installations, deduplication and errors");
