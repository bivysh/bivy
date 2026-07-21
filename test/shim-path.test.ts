import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
// Managed shell-rc PATH block for `bivy shim` (bin/shim-path.mjs). This is the
// fix for shims that install into ~/.local/bin but never win over a version
// manager's bin dir on the interactive PATH.
import {
  MANAGED_BLOCK_START,
  MANAGED_BLOCK_END,
  renderManagedBlock,
  upsertManagedBlock,
  removeManagedBlock,
  hasManagedBlock,
  shimDirToRcExpr,
  rcFileForShell,
} from "../bin/shim-path.mjs";

const HOME = "/home/tester";
const markerCount = (s: string) => (s.match(/>>> bivy shim path >>>/g) || []).length;

// Run a shell script that sources the block on top of a starting PATH, and
// return the resulting PATH split into entries. Skips (returns null) when the
// shell isn't installed on this machine.
function pathAfterBlock(shell: string, startPath: string, block: string): string[] | null {
  if (!spawnSync("sh", ["-c", `command -v ${shell}`], { encoding: "utf8" }).stdout.trim()) return null;
  const script = `PATH=${JSON.stringify(startPath)}\n${block}\nprintf '%s' "$PATH"`;
  const res = spawnSync(shell, ["-c", script], { encoding: "utf8" });
  assert.equal(res.status, 0, `${shell} exited cleanly (stderr: ${res.stderr})`);
  return res.stdout.split(":");
}

function run() {
  // --- shimDirToRcExpr: $HOME abbreviation + quoting ------------------------
  assert.equal(shimDirToRcExpr(`${HOME}/.local/bin`, HOME), '"$HOME/.local/bin"', "under home → $HOME form");
  assert.equal(shimDirToRcExpr(HOME, HOME), '"$HOME"', "home itself → $HOME");
  assert.equal(shimDirToRcExpr("/opt/bivy/bin", HOME), '"/opt/bivy/bin"', "outside home → absolute literal");
  assert.equal(shimDirToRcExpr("/opt/a b/bin", HOME), '"/opt/a b/bin"', "spaces stay inside quotes");
  // A path that is a *sibling* prefix of home must NOT be treated as under home.
  assert.equal(shimDirToRcExpr("/home/tester-2/bin", HOME), '"/home/tester-2/bin"', "sibling prefix is not under home");

  // --- renderManagedBlock: markers + content --------------------------------
  const block = renderManagedBlock([`${HOME}/.local/bin`], { home: HOME });
  assert.ok(block.startsWith(MANAGED_BLOCK_START), "starts with start marker");
  assert.ok(block.trimEnd().endsWith(MANAGED_BLOCK_END), "ends with end marker");
  assert.ok(block.includes('for __bivy_dir in "$HOME/.local/bin"'), "loops over the shim dir expr");
  // Multiple dirs: first-listed must end up frontmost, so it is prepended LAST
  // (i.e. appears LAST in the loop list).
  const multi = renderManagedBlock(["/opt/first/bin", "/opt/second/bin"], { home: HOME });
  const loopLine = multi.split("\n").find((l) => l.startsWith("for __bivy_dir"))!;
  assert.ok(
    loopLine.indexOf('"/opt/second/bin"') < loopLine.indexOf('"/opt/first/bin"'),
    "first-priority dir is prepended last so it wins",
  );
  // De-dupes repeated dirs.
  const dup = renderManagedBlock(["/opt/x/bin", "/opt/x/bin"], { home: HOME });
  const dupLoop = dup.split("\n").find((l) => l.startsWith("for __bivy_dir"))!;
  assert.equal((dupLoop.match(/\/opt\/x\/bin/g) || []).length, 1, "duplicate dirs collapse to one");

  // --- upsert / remove idempotency ------------------------------------------
  const rc0 = 'export EDITOR=vim\neval "$(mise activate bash)"\n';
  const rc1 = upsertManagedBlock(rc0, block);
  assert.equal(markerCount(rc1), 1, "one block after first upsert");
  assert.ok(rc1.indexOf(MANAGED_BLOCK_START) > rc1.indexOf("mise activate"), "block is appended AFTER version-manager init");
  const rc2 = upsertManagedBlock(rc1, renderManagedBlock([`${HOME}/.local/bin`, "/opt/extra/bin"], { home: HOME }));
  assert.equal(markerCount(rc2), 1, "re-upsert replaces, never duplicates");
  assert.ok(rc2.includes("/opt/extra/bin"), "re-upsert reflects the new dir set");
  assert.ok(hasManagedBlock(rc2), "hasManagedBlock true when present");

  const removed = removeManagedBlock(rc2);
  assert.equal(markerCount(removed), 0, "block gone after remove");
  assert.equal(hasManagedBlock(removed), false, "hasManagedBlock false after remove");
  assert.equal(removed, rc0, "remove restores the original rc exactly (no accreted blank lines)");
  // remove is a no-op when there's no block.
  assert.equal(removeManagedBlock(rc0), rc0, "remove is a no-op without a block");
  // upsert into empty content yields just the block.
  assert.equal(upsertManagedBlock("", block), `${block}\n`, "upsert into empty content");

  // --- rcFileForShell -------------------------------------------------------
  assert.deepEqual(rcFileForShell("/bin/zsh", HOME), { file: `${HOME}/.zshrc`, shell: "zsh" }, "zsh → .zshrc");
  assert.deepEqual(rcFileForShell("/usr/local/bin/bash", HOME), { file: `${HOME}/.bashrc`, shell: "bash" }, "bash → .bashrc");
  assert.equal(rcFileForShell("/usr/bin/fish", HOME), null, "unknown shell → null (caller warns)");
  assert.equal(rcFileForShell("", HOME), null, "empty shell → null");

  // --- behavioral: the block actually moves the dir to the front + de-dupes --
  // Use a real, existing dir because the block guards on `[ -d ]`.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-shim-"));
  try {
    const realBlock = renderManagedBlock([dir], { home: HOME });
    for (const shell of ["bash", "zsh"]) {
      // Dir starts in the MIDDLE and duplicated; block must move it to front once.
      const parts = pathAfterBlock(shell, `/usr/bin:${dir}:/bin:${dir}`, realBlock);
      if (!parts) {
        console.log(`shim-path: ${shell} not installed — skipping behavioral check`);
        continue;
      }
      assert.equal(parts[0], dir, `${shell}: shim dir moved to the front`);
      assert.equal(parts.filter((p) => p === dir).length, 1, `${shell}: shim dir de-duplicated`);
      assert.ok(parts.includes("/usr/bin") && parts.includes("/bin"), `${shell}: other entries preserved`);
      // Idempotent: sourcing the block twice keeps the dir first and single.
      const twice = pathAfterBlock(shell, `/usr/bin:${dir}:/bin`, `${realBlock}\n${realBlock}`)!;
      assert.equal(twice[0], dir, `${shell}: still first after sourcing twice`);
      assert.equal(twice.filter((p) => p === dir).length, 1, `${shell}: still single after sourcing twice`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("shim-path: all tests passed");
}

run();
