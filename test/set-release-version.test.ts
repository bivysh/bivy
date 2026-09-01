import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { manifestPaths, setReleaseVersion } from "../scripts/set-release-version.mjs";

function writeManifest(root: string, relativePath: string, version: string): void {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify({ name: relativePath, version }, null, 2)}\n`);
}

test("setReleaseVersion updates root, package, and service manifests", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-release-version-"));
  try {
    writeManifest(root, "package.json", "1.2.3");
    writeManifest(root, "packages/web/package.json", "1.2.3");
    writeManifest(root, "services/relay/package.json", "1.2.2");
    fs.mkdirSync(path.join(root, "packages/not-a-package"), { recursive: true });

    const changed = setReleaseVersion("1.3.0", root);

    assert.deepEqual(changed, ["package.json", "packages/web/package.json", "services/relay/package.json"]);
    assert.equal(manifestPaths(root).length, 3);
    for (const manifest of manifestPaths(root)) {
      assert.equal(JSON.parse(fs.readFileSync(manifest, "utf8")).version, "1.3.0");
    }
    assert.deepEqual(setReleaseVersion("1.3.0", root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setReleaseVersion rejects prerelease and malformed versions", () => {
  assert.throws(() => setReleaseVersion("1.2.3-beta.1", "/missing"), /stable X\.Y\.Z/);
  assert.throws(() => setReleaseVersion("v1.2.3", "/missing"), /stable X\.Y\.Z/);
});
