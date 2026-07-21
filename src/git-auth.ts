// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Git credential handling for repos Bivy clones on behalf of a user.
//
// Remotes are kept CLEAN (https://github.com/<owner>/<repo>.git); credentials are
// supplied on demand by a daemon-owned git credential helper. The helper stores
// NO token on disk — on every git operation it calls the node's loopback
// git-credential endpoint (see src/server.ts) and gets a FRESH token. This keeps
// nothing long-lived or stale on disk (important once tokens are short-lived
// GitHub App installation tokens), and works for both daemon- and agent-run git
// since both run under a live daemon.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set by configureGitAuth() at daemon startup. Falls back to BIVY_DATA_DIR / the
// default data dir so the module still works in tests and one-off scripts.
let credRootOverride: string | null = null;

function dataDir(): string {
  return process.env.BIVY_DATA_DIR ? path.resolve(process.env.BIVY_DATA_DIR) : path.join(os.homedir(), ".bivy");
}
function credDir(): string {
  return credRootOverride ?? path.join(dataDir(), "git-cred");
}
function shimPath(): string {
  return path.join(credDir(), "credential-helper.sh");
}
function workerPath(): string {
  return path.join(credDir(), "credential-helper.mjs");
}
function endpointPath(): string {
  return path.join(credDir(), "endpoint.json");
}

/** The token-free remote URL for a repo. */
export function cleanRemoteUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

// The credential-helper worker (plain ESM, run by node). Reads git's request on
// stdin, and for a github.com repo fetches a fresh token from the node's loopback
// endpoint. Finds endpoint.json next to itself (import.meta.url), so no paths are
// baked in. Prints nothing on any miss/error, so git fails auth cleanly (fast,
// because the daemon runs it with GIT_TERMINAL_PROMPT=0).
const WORKER_SOURCE = `import fs from 'node:fs';
import http from 'node:http';
if (process.argv[2] !== 'get') process.exit(0);
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
const attrs = {};
for (const line of input.split('\\n')) { const i = line.indexOf('='); if (i > 0) attrs[line.slice(0, i)] = line.slice(i + 1).trim(); }
if (attrs.host !== 'github.com') process.exit(0);
const m = /^([^/]+)\\/(.+?)(?:\\.git)?$/.exec(attrs.path || '');
if (!m) process.exit(0);
let ep;
try { ep = JSON.parse(fs.readFileSync(new URL('./endpoint.json', import.meta.url), 'utf8')); } catch { process.exit(0); }
if (!ep || !ep.url || !ep.secret) process.exit(0);
const u = new URL(ep.url + '/api/git-credential');
u.searchParams.set('owner', m[1]);
u.searchParams.set('repo', m[2]);
const token = await new Promise((resolve) => {
  const req = http.get(u, { headers: { 'x-bivy-bootstrap': ep.secret } }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return resolve(null); }
    let body = ''; res.setEncoding('utf8');
    res.on('data', (d) => (body += d));
    res.on('end', () => { try { resolve(JSON.parse(body).token || null); } catch { resolve(null); } });
  });
  req.on('error', () => resolve(null));
  req.setTimeout(5000, () => { req.destroy(); resolve(null); });
});
if (token) process.stdout.write('username=x-access-token\\npassword=' + token + '\\n');
`;

function shDq(s: string): string {
  return `"${s.replace(/(["\\$\`])/g, "\\$1")}"`;
}

function writeIfChanged(file: string, content: string, mode: number): void {
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    // not written yet
  }
  if (existing !== content) fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}

/**
 * (Re)write the credential helper and return the git-config helper path. The
 * helper is a tiny sh shim that execs THIS daemon's node (absolute path baked in,
 * so it works regardless of the caller's PATH — e.g. an agent shell) on the worker
 * script above. Idempotent.
 */
export function ensureCredentialHelper(): string {
  fs.mkdirSync(credDir(), { recursive: true, mode: 0o700 });
  writeIfChanged(workerPath(), WORKER_SOURCE, 0o700);
  const shim = `#!/usr/bin/env sh\nexec ${shDq(process.execPath)} ${shDq(workerPath())} "$@"\n`;
  writeIfChanged(shimPath(), shim, 0o700);
  return shimPath();
}

/** Point the module at the node data dir and materialize the helper. */
export function configureGitAuth(appDir: string): void {
  credRootOverride = path.join(appDir, "git-cred");
  ensureCredentialHelper();
}

/**
 * Publish the loopback endpoint (URL + bootstrap secret) that the helper calls to
 * fetch a fresh token. 0600 — the secret gates the endpoint against other local
 * users on a shared host. Call once the daemon knows its port + bootstrap secret.
 */
export function writeGitCredentialEndpoint(url: string, secret: string): void {
  fs.mkdirSync(credDir(), { recursive: true, mode: 0o700 });
  writeIfChanged(endpointPath(), `${JSON.stringify({ url, secret })}\n`, 0o600);
}

/**
 * `-c` flags that make a single git invocation use the helper for github.com with
 * the repo path (so the helper can resolve owner/repo). Non-secret (only the
 * helper's path). Use for daemon-run clone/fetch/push against a clean URL.
 */
export function credConfigArgs(): string[] {
  const helper = ensureCredentialHelper();
  return [
    "-c",
    "credential.https://github.com.useHttpPath=true",
    "-c",
    `credential.https://github.com.helper=${helper}`,
  ];
}

/** Env that makes git non-interactive, so a credential miss fails fast (never hangs). */
export function gitNonInteractiveEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
}

/**
 * Persist the helper config into a clone's local `.git/config` so AGENT-run git
 * (a bare `git push origin` from inside the workspace) authenticates too, without
 * the daemon's `-c` flags. Only the helper path is stored — never a token.
 */
export async function configureRepoCredentialHelper(
  git: (args: string[]) => Promise<unknown>,
  dest: string,
): Promise<void> {
  const helper = ensureCredentialHelper();
  await git(["-C", dest, "config", "--local", "credential.https://github.com.useHttpPath", "true"]);
  await git(["-C", dest, "config", "--local", "credential.https://github.com.helper", helper]);
}
