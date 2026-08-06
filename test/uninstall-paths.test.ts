import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeExcept, removeInstallAndState } from "../bin/uninstall-paths.mjs";

// Regression coverage for issue #461: `bivy uninstall --keep-sessions` used to
// move only the raw pi transcripts aside to a one-off backup folder nothing
// ever restored, while unconditionally deleting the durable session index
// (metadata.json) — so kept sessions never reappeared after a fresh reinstall.
// `removeExcept` is the fix: delete an app's state dir except the specific
// paths the caller wants kept, in place.

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-uninstall-paths-"));
  fs.mkdirSync(path.join(root, "pi", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(root, "pi", "sessions", "session1.jsonl"), '{"id":"s1"}\n');
  fs.writeFileSync(path.join(root, "pi", "auth.json"), '{"token":"pi-credential"}');
  // The shared, agent-neutral credential vault now lives at <dataDir>/credentials
  // (moved out of <dataDir>/pi). It must still be removed on uninstall.
  fs.mkdirSync(path.join(root, "credentials"), { recursive: true });
  fs.writeFileSync(path.join(root, "credentials", "auth.enc"), "encrypted-vault");
  fs.writeFileSync(path.join(root, "credentials", "auth.key"), "vault-key");
  fs.writeFileSync(path.join(root, "metadata.json"), '{"version":1,"sessions":{"s1":{"id":"s1"}}}');
  fs.writeFileSync(path.join(root, "cli.json"), '{"workspace":"/tmp"}');
  fs.writeFileSync(path.join(root, "secrets.json"), '{"key":"super-secret"}');
  fs.mkdirSync(path.join(root, "repos", "example", ".bivy", "worktrees", "branch"), { recursive: true });
  fs.writeFileSync(path.join(root, "repos", "example", ".bivy", "worktrees", "branch", "file.txt"), "work");
  return root;
}

// --- keepSessions: pi/sessions and metadata.json survive, everything else goes.
{
  const root = makeFixture();
  const sessionsDir = path.join(root, "pi", "sessions");
  const metadataPath = path.join(root, "metadata.json");
  removeExcept(root, [sessionsDir, metadataPath]);

  assert.equal(fs.existsSync(root), true, "the app dir itself survives when something is kept");
  assert.equal(
    fs.readFileSync(path.join(sessionsDir, "session1.jsonl"), "utf8"),
    '{"id":"s1"}\n',
    "kept session transcript is untouched, not just present",
  );
  assert.equal(
    fs.readFileSync(metadataPath, "utf8"),
    '{"version":1,"sessions":{"s1":{"id":"s1"}}}',
    "kept session index is untouched",
  );
  assert.equal(fs.existsSync(path.join(root, "pi", "auth.json")), false, "non-kept files under a pruned ancestor dir are removed");
  assert.equal(fs.existsSync(path.join(root, "cli.json")), false, "config is still removed even when sessions are kept");
  assert.equal(fs.existsSync(path.join(root, "secrets.json")), false, "credentials are still removed even when sessions are kept");
  assert.equal(fs.existsSync(path.join(root, "credentials")), false, "the shared credential vault (<dataDir>/credentials) is removed even when sessions are kept");
  assert.equal(fs.existsSync(path.join(root, "repos")), false, "unrelated subtrees are still removed wholesale");
  fs.rmSync(root, { recursive: true, force: true });
}

// --- No keep paths: identical to `rm -rf root` (the default, non-preserving path).
{
  const root = makeFixture();
  removeExcept(root, []);
  assert.equal(fs.existsSync(root), false, "with nothing to keep, the whole dir is removed");
}

// --- A keep path that doesn't exist is simply never encountered, no crash.
{
  const root = makeFixture();
  removeExcept(root, [path.join(root, "pi", "sessions"), path.join(root, "does-not-exist.json")]);
  assert.equal(fs.existsSync(path.join(root, "pi", "sessions", "session1.jsonl")), true, "the real keep path still survives");
  fs.rmSync(root, { recursive: true, force: true });
}

// --- npm-global layout: state lives outside the replaceable package directory.
// Regression coverage: uninstall previously deleted only installDir, leaving
// ~/.bivy/cli.json behind, so install.sh incorrectly treated a reinstall as an update.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-uninstall-npm-"));
  const installDir = path.join(root, "prefix", "lib", "node_modules", "@bivy", "bivy");
  const stateDir = path.join(root, "home", ".bivy");
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, "package.json"), "{}");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "cli.json"), '{"workspace":"/tmp"}');
  fs.writeFileSync(path.join(stateDir, "channel"), "staging\n");

  removeInstallAndState(installDir, stateDir);

  assert.equal(fs.existsSync(installDir), false, "the npm package directory is removed");
  assert.equal(fs.existsSync(stateDir), false, "the separate npm-global state directory is removed");
  fs.rmSync(root, { recursive: true, force: true });
}

// --- Tarball layout: state is nested in the disposable install directory.
// Keeping sessions must retain only their directory chain, not the package.
{
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-uninstall-tarball-"));
  const stateDir = path.join(installDir, ".bivy");
  fs.mkdirSync(path.join(stateDir, "pi", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "pi", "sessions", "session1.jsonl"), "{}");
  fs.writeFileSync(path.join(stateDir, "cli.json"), "{}");
  fs.writeFileSync(path.join(installDir, "package.json"), "{}");
  const keptSessionDir = path.join(stateDir, "pi", "sessions");

  removeInstallAndState(installDir, stateDir, { keepState: [keptSessionDir] });

  assert.equal(fs.existsSync(path.join(keptSessionDir, "session1.jsonl")), true, "nested sessions are retained");
  assert.equal(fs.existsSync(path.join(stateDir, "cli.json")), false, "nested state config is removed");
  assert.equal(fs.existsSync(path.join(installDir, "package.json")), false, "tarball package files are removed");
  fs.rmSync(installDir, { recursive: true, force: true });
}

console.log("uninstall-paths: ok");
