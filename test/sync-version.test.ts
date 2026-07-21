import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncVersion, TARGETS } from "../scripts/sync-version.mjs";

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

// Builds a scratch "repo" containing a root package.json plus every file
// sync-version.mjs targets, so tests can exercise the real regexes/read/write
// logic without touching the actual repo. `overrides` seeds specific targets
// with a different (drifted) version; everything else starts in sync.
function makeFixture(rootVersion: string, overrides: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-sync-version-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "bivy", version: rootVersion }, null, 2) + "\n");
  for (const target of TARGETS) {
    const abs = path.join(dir, target.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const version = overrides[target.rel] ?? rootVersion;
    const content = target.rel.endsWith(".mjs")
      ? `await asRequest("initialize", { clientInfo: { name: "bivy", title: "Bivy", version: "${version}" }, capabilities: {} });\n`
      : JSON.stringify({ name: path.basename(path.dirname(abs)), version }, null, 2) + "\n";
    fs.writeFileSync(abs, content);
  }
  return dir;
}

await check("--check passes and reports no drift when everything already matches", () => {
  const dir = makeFixture("1.2.3");
  try {
    const result = syncVersion(dir, { check: true });
    assert.equal(result.version, "1.2.3");
    assert.deepEqual(result.drifted, []);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.updated, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("--check reports drift (including the shim literal) without writing", () => {
  const dir = makeFixture("1.2.3", {
    "packages/core/package.json": "1.2.2",
    "bin/codex-app-server-shim.mjs": "1.2.2",
  });
  try {
    const beforeCore = fs.readFileSync(path.join(dir, "packages/core/package.json"), "utf8");
    const beforeShim = fs.readFileSync(path.join(dir, "bin/codex-app-server-shim.mjs"), "utf8");

    const result = syncVersion(dir, { check: true });

    assert.equal(result.problems.length, 0);
    assert.equal(result.updated.length, 0);
    assert.deepEqual(
      result.drifted.map((d) => d.rel).sort(),
      ["bin/codex-app-server-shim.mjs", "packages/core/package.json"],
    );

    // --check must never write.
    assert.equal(fs.readFileSync(path.join(dir, "packages/core/package.json"), "utf8"), beforeCore);
    assert.equal(fs.readFileSync(path.join(dir, "bin/codex-app-server-shim.mjs"), "utf8"), beforeShim);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("sync (no --check) writes the root version into every drifted target", () => {
  const dir = makeFixture("2.0.0", {
    "packages/web/package.json": "1.9.9",
    "services/relay/package.json": "1.9.9",
    "bin/codex-app-server-shim.mjs": "1.9.9",
  });
  try {
    const result = syncVersion(dir, { check: false });

    assert.equal(result.problems.length, 0);
    assert.deepEqual(
      result.updated.map((u) => u.rel).sort(),
      ["bin/codex-app-server-shim.mjs", "packages/web/package.json", "services/relay/package.json"],
    );

    for (const target of TARGETS) {
      const text = fs.readFileSync(path.join(dir, target.rel), "utf8");
      assert.equal(target.read(text), "2.0.0", `${target.rel} should now read 2.0.0`);
    }

    // Formatting outside the version field must be left alone: the shim's
    // clientInfo.name should survive untouched.
    const shimText = fs.readFileSync(path.join(dir, "bin/codex-app-server-shim.mjs"), "utf8");
    assert.match(shimText, /name: "bivy"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("a missing target file is reported as a problem, not silently skipped", () => {
  const dir = makeFixture("1.0.0");
  fs.rmSync(path.join(dir, "packages/core/package.json"));
  try {
    const result = syncVersion(dir, { check: true });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /packages\/core\/package\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (failures) {
  console.error(`\n${failures} sync-version test(s) failed`);
  process.exit(1);
}
console.log("sync-version tests passed");
