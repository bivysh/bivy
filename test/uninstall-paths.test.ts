import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeExcept } from "../bin/uninstall-paths.mjs";

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

console.log("uninstall-paths: ok");
