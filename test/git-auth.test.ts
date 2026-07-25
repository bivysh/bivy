import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import {
  cleanRemoteUrl,
  configureGitAuth,
  writeGitCredentialEndpoint,
  credConfigArgs,
  configureRepoCredentialHelper,
} from "../src/git-auth.js";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-git-auth-"));
const dataDir = path.join(tmp, "data");
fs.mkdirSync(dataDir, { recursive: true });
configureGitAuth(dataDir);

// A stub of the daemon's loopback git-credential endpoint. Records each request
// so we can assert the helper passed owner/repo + the bootstrap secret, and
// returns a fresh token per repo (or 404 when unknown).
const SECRET = "test-bootstrap-secret";
const served = new Map([
  ["bivysh/bivy", "ghs_freshtoken"],
  ["acme/widgets", "ghs_widgetstoken"],
]);
const requests: Array<{ path: string; secret?: string; owner: string | null; repo: string | null }> = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://127.0.0.1");
  const secret = req.headers["x-bivy-bootstrap"];
  requests.push({
    path: u.pathname,
    secret: Array.isArray(secret) ? secret[0] : secret,
    owner: u.searchParams.get("owner"),
    repo: u.searchParams.get("repo"),
  });
  res.setHeader("content-type", "application/json");
  if (u.pathname !== "/api/git-credential") return res.writeHead(404).end("{}");
  if (secret !== SECRET) return res.writeHead(403).end(JSON.stringify({ error: "bad secret" }));
  const token = served.get(`${u.searchParams.get("owner")}/${u.searchParams.get("repo")}`);
  if (!token) return res.writeHead(404).end(JSON.stringify({ error: "no token" }));
  return res.writeHead(200).end(JSON.stringify({ token }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const addr = server.address() as { port: number };
const endpointUrl = `http://127.0.0.1:${addr.port}`;
writeGitCredentialEndpoint(endpointUrl, SECRET);

// Run git ASYNCHRONOUSLY (not execFileSync) so the test's event loop stays free
// to serve the stub endpoint while the credential helper calls it — mirroring the
// daemon, which spawns git via async execFile. A synchronous git call would
// deadlock: the in-process stub couldn't answer the helper mid-call.
function git(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const cp = execFile("git", args, { encoding: "utf8" }, (err, stdout) => {
      if (err) reject(Object.assign(err as Error, { stdout }));
      else resolve(stdout);
    });
    if (input !== undefined) {
      cp.stdin!.write(input);
      cp.stdin!.end();
    }
  });
}

// Resolve credentials for a repo the way clone/fetch/push do, using the exact
// `-c` flags the daemon injects.
function credentialFill(repoPath: string): Promise<string> {
  return git([...credConfigArgs(), "credential", "fill"], `protocol=https\nhost=github.com\npath=${repoPath}\n\n`);
}

await check("cleanRemoteUrl has no userinfo/token", () => {
  const url = cleanRemoteUrl("bivysh", "bivy");
  assert.equal(url, "https://github.com/bivysh/bivy.git");
  assert.ok(!url.includes("@"), "clean URL must not contain userinfo");
});

await check("helper fetches a fresh token from the endpoint (owner/repo + secret)", async () => {
  const out = await credentialFill("bivysh/bivy.git");
  assert.match(out, /username=x-access-token/);
  assert.match(out, /password=ghs_freshtoken/);
  const last = requests[requests.length - 1];
  assert.equal(last.path, "/api/git-credential");
  assert.equal(last.owner, "bivysh");
  assert.equal(last.repo, "bivy");
  assert.equal(last.secret, SECRET);
});

await check("helper serves per-repo tokens (different repo → different token)", async () => {
  const out = await credentialFill("acme/widgets.git");
  assert.match(out, /password=ghs_widgetstoken/);
});

await check("helper supplies no credential when the endpoint has no token (404)", async () => {
  // The endpoint 404s, so the helper stays silent and git finds no credential. In
  // a non-interactive context (GIT_TERMINAL_PROMPT=0, as the daemon runs it) that
  // is a fast failure; `credential fill` here has no tty, so it errors. Assert it
  // never yields a password either way.
  let out = "";
  try {
    out = await credentialFill("nobody/norepo.git");
  } catch (error) {
    out = String((error as { stdout?: string }).stdout ?? "");
  }
  assert.ok(!/password=/.test(out), `expected no password, got: ${out}`);
});

await check("credConfigArgs resets the helper chain before adding bivy's helper", () => {
  // Guards H1: a pre-existing host github.com helper (osxkeychain, `gh`, store)
  // must not shadow bivy's and leak the human's personal token into agent clones.
  const args = credConfigArgs();
  const flags = args.filter((_, i) => i % 2 === 1); // values follow each "-c"
  // Empty resets must appear, and must come BEFORE bivy's real helper value.
  assert.ok(flags.includes("credential.helper="), "must clear the generic helper chain");
  assert.ok(flags.includes("credential.https://github.com.helper="), "must clear the host helper chain");
  const resetIdx = flags.indexOf("credential.https://github.com.helper=");
  const realIdx = flags.findIndex((f) => /^credential\.https:\/\/github\.com\.helper=.+/.test(f));
  assert.ok(realIdx > resetIdx, "bivy's helper must be added after the reset");
});

await check("nothing long-lived is stored on disk (fetch-on-demand)", () => {
  const credDir = path.join(dataDir, "git-cred");
  assert.ok(fs.existsSync(path.join(credDir, "credential-helper.sh")), "shim should exist");
  assert.ok(fs.existsSync(path.join(credDir, "credential-helper.mjs")), "worker should exist");
  // No per-repo token files anywhere — the only on-disk secret is endpoint.json's
  // bootstrap secret (0600), which is not a GitHub token.
  assert.ok(!fs.existsSync(path.join(credDir, "tokens")), "no token files should exist");
  const epFile = path.join(credDir, "endpoint.json");
  const ep = JSON.parse(fs.readFileSync(epFile, "utf8"));
  assert.equal(ep.url, endpointUrl);
  assert.equal(ep.secret, SECRET);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(epFile).mode & 0o777, 0o600, "endpoint.json must be 0600");
  }
});

await check("configureRepoCredentialHelper persists helper config, not a token", async () => {
  const repo = path.join(tmp, "clone");
  fs.mkdirSync(repo, { recursive: true });
  await git(["-C", repo, "init", "-q"]);
  await configureRepoCredentialHelper((a) => git(a), repo);
  const helper = (await git(["-C", repo, "config", "--local", "--get", "credential.https://github.com.helper"])).trim();
  assert.ok(helper.endsWith("credential-helper.sh"), `expected helper path, got: ${helper}`);
  const cfg = fs.readFileSync(path.join(repo, ".git", "config"), "utf8");
  assert.ok(!/ghs_|gho_|ghp_|x-access-token:/.test(cfg), "no token must be written into .git/config");
});

await check("migration: rewriting a tokenized origin to clean drops the token", async () => {
  const repo = path.join(tmp, "legacy");
  fs.mkdirSync(repo, { recursive: true });
  await git(["-C", repo, "init", "-q"]);
  await git(["-C", repo, "remote", "add", "origin", "https://x-access-token:gho_leaked@github.com/bivysh/bivy.git"]);
  await git(["-C", repo, "remote", "set-url", "origin", cleanRemoteUrl("bivysh", "bivy")]);
  const remotes = await git(["-C", repo, "remote", "-v"]);
  assert.ok(!remotes.includes("gho_leaked"), "token must be gone from the remote");
  assert.ok(!remotes.includes("@github.com"), "no userinfo should remain in the remote");
  assert.match(remotes, /https:\/\/github\.com\/bivysh\/bivy\.git/);
});

server.close();
fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\ngit-auth: ${failures} test(s) failed`);
  process.exit(1);
}
console.log("\ngit-auth: all tests passed");
