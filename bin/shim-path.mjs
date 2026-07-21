// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Managed shell-rc PATH block for `bivy shim`.
//
// Installing a shim into `~/.local/bin` only helps if that directory wins over
// the real binary on the user's interactive PATH. It usually does NOT: version
// managers (mise/asdf/nvm/pyenv) inject their bin dirs via shell-init hooks that
// run *during* interactive startup and prepend to PATH — after any static
// `export PATH="$HOME/.local/bin:$PATH"` the user may have set. So the real
// agent keeps winning and the shim never fires (see the original report).
//
// The reliable fix is a small, clearly-marked block that Bivy manages at the END
// of the user's rc file (`.zshrc`/`.bashrc`) — i.e. AFTER the version-manager
// init — that force-moves the shim dir(s) to the front of PATH. This module is
// the pure, unit-tested core: render the block, and idempotently upsert/remove
// it inside arbitrary rc-file text. `bin/bivy.mjs` does the file IO.
//
// The block is written to be valid in both bash and zsh (the shells whose rc we
// touch). It deliberately avoids `for d in $PATH` word-splitting — which behaves
// differently in zsh — and instead rewrites PATH with parameter substitution.

import os from "node:os";
import path from "node:path";

export const MANAGED_BLOCK_START = "# >>> bivy shim path >>>";
export const MANAGED_BLOCK_END = "# <<< bivy shim path <<<";

// Render a directory as a shell expression for the rc file. Directories under
// $HOME are emitted as "$HOME/…" so the block stays portable across machines
// that sync dotfiles; anything else is an absolute, double-quoted literal. In
// both forms the value is double-quoted, so spaces are handled and the leading
// `$HOME` still expands.
export function shimDirToRcExpr(dir, home = os.homedir()) {
  const resolved = path.resolve(dir);
  const h = path.resolve(home);
  const esc = (s) => s.replace(/(["\\$`])/g, "\\$1");
  if (resolved === h) return '"$HOME"';
  if (resolved.startsWith(h + path.sep)) {
    return `"$HOME${esc(resolved.slice(h.length))}"`;
  }
  return `"${esc(resolved)}"`;
}

// Render the managed block for one or more shim directories. Later-listed dirs
// are prepended first so the FIRST directory in `dirs` ends up frontmost on
// PATH (highest priority).
export function renderManagedBlock(dirs, { home = os.homedir() } = {}) {
  const unique = [...new Set(dirs.map((d) => path.resolve(d)))];
  const exprs = unique
    .slice()
    .reverse()
    .map((d) => shimDirToRcExpr(d, home))
    .join(" ");
  return [
    MANAGED_BLOCK_START,
    "# Keeps Bivy's agent-shim dir(s) ahead of version-manager bins so that a",
    "# shimmed agent resolves to its Bivy shim, not the real binary. Managed by",
    "# `bivy shim`: regenerated on install, removed when the last shim is gone.",
    "# Do not edit — your changes will be overwritten. (Valid in bash and zsh.)",
    `for __bivy_dir in ${exprs}; do`,
    '  [ -d "$__bivy_dir" ] || continue',
    '  case ":$PATH:" in',
    '    *":$__bivy_dir:"*)',
    '      PATH=":$PATH:"',
    '      PATH="${PATH//:$__bivy_dir:/:}"',
    '      PATH="${PATH#:}"; PATH="${PATH%:}" ;;',
    "  esac",
    '  PATH="$__bivy_dir${PATH:+:$PATH}"',
    "done",
    "unset __bivy_dir",
    "export PATH",
    MANAGED_BLOCK_END,
  ].join("\n");
}

// True if `content` already contains a managed block.
export function hasManagedBlock(content) {
  return typeof content === "string" && content.includes(MANAGED_BLOCK_START);
}

// Return `content` with any managed block removed. Line-based so it tolerates
// leading/trailing whitespace on the marker lines, and collapses the blank-line
// gap the block leaves behind so repeated upsert/remove cycles don't accrete
// blank lines.
export function removeManagedBlock(content) {
  if (typeof content !== "string" || content === "") return content ?? "";
  const lines = content.split("\n");
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inBlock && trimmed === MANAGED_BLOCK_START) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (trimmed === MANAGED_BLOCK_END) inBlock = false;
      continue;
    }
    out.push(line);
  }
  // Collapse 2+ trailing blank lines (left where the block used to be) to a
  // single trailing newline.
  return out.join("\n").replace(/\n{2,}$/, "\n");
}

// Idempotently place `block` at the END of `content` (after version-manager
// init). Any existing managed block is removed first, so re-running never
// duplicates it and always re-anchors the block last.
export function upsertManagedBlock(content, block) {
  const cleaned = removeManagedBlock(content || "").replace(/\s*$/, "");
  if (cleaned === "") return `${block}\n`;
  return `${cleaned}\n\n${block}\n`;
}

// Resolve which rc file to manage for a given login shell. Returns
// `{ file, shell }` for shells whose rc we understand (zsh/bash), or `null`
// when we can't safely auto-manage (caller should print manual instructions).
export function rcFileForShell(shellPath, home = os.homedir()) {
  const shell = path.basename(String(shellPath || "")).toLowerCase();
  if (shell.includes("zsh")) return { file: path.join(home, ".zshrc"), shell: "zsh" };
  // Interactive bash terminals source ~/.bashrc (login shells chain to it from
  // ~/.bash_profile on most setups); that's where the interactive PATH lives.
  if (shell.includes("bash")) return { file: path.join(home, ".bashrc"), shell: "bash" };
  return null;
}
