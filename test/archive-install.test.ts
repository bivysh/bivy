// `bivy update` for archive installs (bin/archive-install.mjs): a new version is
// staged and verified beside the running one, `current` moves to it, one
// previous version stays for rollback, and a bad download changes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { activate, activeVersion, archiveInstall, prune, stageArchive } from "../bin/archive-install.mjs";

const target = "linux-x64";

/** A minimal archive for `version`, served by the returned fetch. */
function release(work: string, version: string) {
  const name = `bivy-${version}-${target}`;
  const src = path.join(work, "src", name);
  fs.mkdirSync(path.join(src, "app"), { recursive: true });
  fs.writeFileSync(path.join(src, "bivy-archive.json"), JSON.stringify({ version, target }));
  const file = path.join(work, `${name}.tar.gz`);
  assert.equal(spawnSync("tar", ["-czf", file, "-C", path.dirname(src), name]).status, 0);
  const bytes = fs.readFileSync(file);
  const manifest = { version, archives: { [target]: { file: `${name}.tar.gz`, sha256: crypto.createHash("sha256").update(bytes).digest("hex") } } };
  const download = (_url: string, dest: string) => fs.writeFileSync(dest, bytes);
  return { manifest, download, archiveUrl: () => "https://releases.test/archive" };
}

test("updates stage beside the running version, swap current, and keep one previous", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-archive-"));
  const installRoot = path.join(work, "install");
  try {
    const dirs = [];
    for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
      const dir = await stageArchive({ installRoot, target, ...release(work, version) });
      const previous = activate(installRoot, dir);
      prune(installRoot, [dir, previous]);
      dirs.push(dir);
    }
    assert.equal(activeVersion(installRoot), dirs[2]);
    assert.deepEqual(fs.readdirSync(path.join(installRoot, "versions")).sort(), ["1.1.0-linux-x64", "1.2.0-linux-x64"]);

    // The launcher's root resolves to the install, through `current`.
    const install = archiveInstall(path.join(installRoot, "current"), path.join(dirs[2], "app"));
    assert.deepEqual(install, { root: path.join(installRoot, "current"), installRoot, version: "1.2.0", target });
    // A root inherited by some other checkout is not this install.
    assert.equal(archiveInstall(path.join(installRoot, "current"), work), null);

    const bad = release(work, "1.3.0");
    bad.manifest.archives[target].sha256 = "0".repeat(64);
    await assert.rejects(stageArchive({ installRoot, target, ...bad }), /failed verification/);
    assert.equal(activeVersion(installRoot), dirs[2]);
    assert.deepEqual(fs.readdirSync(path.join(installRoot, "versions")).sort(), ["1.1.0-linux-x64", "1.2.0-linux-x64"]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
