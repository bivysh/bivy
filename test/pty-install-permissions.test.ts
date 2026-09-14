import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { repairPtyPermissions } from "../bin/repair-pty-permissions.mjs";

for (const layout of ["nested", "hoisted"]) {
  for (const arch of ["arm64", "x64"]) {
    test(`Darwin ${arch}: repair only PTY helpers in a ${layout} install`, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-pty-install-"));
      try {
        const root = path.join(tmp, "node_modules", "@bivy", "bivy");
        const ptyRoot = path.join(layout === "nested" ? root : tmp, "node_modules", "node-pty");
        fs.mkdirSync(root, { recursive: true });
        fs.mkdirSync(ptyRoot, { recursive: true });
        fs.writeFileSync(path.join(root, "package.json"), "{}");
        fs.writeFileSync(path.join(ptyRoot, "package.json"), '{"name":"node-pty","version":"1.1.0"}');
        const helpers = ["build/Release", "build/Debug", `prebuilds/darwin-${arch}`].map((dir) => {
          fs.mkdirSync(path.join(ptyRoot, dir), { recursive: true });
          const helper = path.join(ptyRoot, dir, "spawn-helper");
          fs.writeFileSync(helper, "binary fixture");
          fs.chmodSync(helper, 0o644);
          return helper;
        });
        const unrelated = path.join(ptyRoot, "package.json");
        const unrelatedMode = fs.statSync(unrelated).mode;
        repairPtyPermissions(root, "darwin", arch);
        for (const helper of helpers) {
          assert.equal(fs.statSync(helper).mode & 0o777, 0o755);
          assert.equal(fs.readFileSync(helper, "utf8"), "binary fixture");
        }
        assert.equal(fs.statSync(unrelated).mode, unrelatedMode);
        const mtimes = helpers.map((file) => fs.statSync(file).ctimeMs);
        repairPtyPermissions(root, "darwin", arch);
        assert.deepEqual(helpers.map((file) => fs.statSync(file).ctimeMs), mtimes, "already executable helpers are untouched");

        // Do not chmod through an unexpected symlink outside node-pty.
        fs.unlinkSync(helpers[0]);
        fs.symlinkSync(unrelated, helpers[0]);
        fs.unlinkSync(helpers[1]);
        repairPtyPermissions(root, "darwin", arch);
        assert.equal(fs.statSync(unrelated).mode, unrelatedMode);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
}

test("other platforms need no helper repair or dependency lookup", () => {
  assert.doesNotThrow(() => repairPtyPermissions("/nonexistent-bivy-fixture", "linux", "x64"));
  assert.doesNotThrow(() => repairPtyPermissions("/nonexistent-bivy-fixture", "win32", "arm64"));
});
