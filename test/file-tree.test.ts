import assert from "node:assert/strict";
import { buildFileTree, reviewStates, reviewStateLabel, type FileTreeFile } from "../packages/web/src/fileTree.js";

// Pure projections behind the changed-file review surface (C3a tree + C3b state).

let failures = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}\n      ${(error as Error).message}`); }
}

const f = (path: string): FileTreeFile => ({ path, status: "modified" });

check("buildFileTree nests by directory, dirs before files, alphabetical", () => {
  const tree = buildFileTree([f("src/b.ts"), f("README.md"), f("src/a.ts")]);
  // src/ dir sorts before README.md file at the root.
  assert.deepEqual(tree.map((n) => `${n.type}:${n.name}`), ["dir:src", "file:README.md"]);
  const src = tree[0]!;
  assert.deepEqual(src.children!.map((n) => n.name), ["a.ts", "b.ts"]);
  assert.equal(src.children![0]!.type, "file");
});

check("buildFileTree collapses single-child directory chains", () => {
  const tree = buildFileTree([f("packages/web/src/App.tsx")]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]!.name, "packages/web/src", "a single-child dir chain collapses into one node");
  assert.equal(tree[0]!.children![0]!.name, "App.tsx");
});

check("buildFileTree keeps a file and its carried metadata at the leaf", () => {
  const tree = buildFileTree([{ path: "a/x.ts", status: "added", added: 5, removed: 0 }]);
  const leaf = tree[0]!.children![0]!;
  assert.equal(leaf.type, "file");
  assert.equal(leaf.file?.status, "added");
  assert.equal(leaf.file?.added, 5);
});

check("reviewStates orders local→shared and omits absent states", () => {
  assert.deepEqual(reviewStates({ hasWorkingChanges: true, hasCheckpoint: true, output: { branch: "b", commit: "c", prUrl: "p" } }),
    ["working-tree", "checkpoint", "branch", "commit", "pull-request"]);
  assert.deepEqual(reviewStates({ hasCheckpoint: true, output: { prUrl: "p" } }), ["checkpoint", "pull-request"]);
  assert.deepEqual(reviewStates({}), []);
  assert.equal(reviewStateLabel("pull-request"), "Pull request");
});

if (failures > 0) { console.error(`\n${failures} file-tree test(s) failed`); process.exit(1); }
console.log("\nfile-tree: all tests passed");
