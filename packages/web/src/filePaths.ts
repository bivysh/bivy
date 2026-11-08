// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// File paths an agent writes in its replies, opened in the Files viewer.
//
// Agents of every kind name the files they touched as inline code
// (`src/server.ts`, `src/server.ts:120`). After the markdown is in the DOM, each
// inline `<code>` whose whole text reads as a workspace-relative path becomes a
// button that opens that file (at that line) in the session's Files viewer. The
// node resolves and confines the path as it does for the Files tree, so a path
// that doesn't exist just shows the viewer's error.

export interface FileRef { path: string; line?: number }

// A relative path: no scheme, no leading `/` or `~`, no `..` segment, no spaces.
const PATH = /^(?:\.\/)?((?:[\w@+-][\w.@+-]*\/)*[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,10})(?::(\d{1,7})(?::\d{1,5})?)?$/;
// A bare file name (no `/`) only counts with one of these extensions, so
// `res.json`, `JSON.parse` or `v1.2` stay code. A path with a folder counts
// with any extension.
const BARE_EXTENSIONS = new Set(["md", "mdx", "txt", "yaml", "yml", "toml", "lock", "csv", "html", "css", "scss", "sh", "py", "ts", "tsx", "jsx", "mjs", "cjs", "go", "rs", "rb", "java", "kt", "swift", "c", "h", "cpp", "hpp", "sql", "env", "ini", "xml", "svg", "png", "jpg", "jpeg", "gif", "webp"]);

/** The file an inline code span names, if its whole text reads as one. */
export function fileRefOf(text: string): FileRef | undefined {
  const match = PATH.exec(text.trim());
  if (!match) return undefined;
  const path = match[1]!;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
  if (!path.includes("/") && !BARE_EXTENSIONS.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase())) return undefined;
  const line = match[2] ? Number(match[2]) : undefined;
  return line ? { path, line } : { path };
}

/** Mark every inline code span in `root` that names a file as a button that
 *  opens it. Idempotent: already-marked spans are skipped. */
export function decorateFilePaths(root: HTMLElement | null): void {
  if (!root) return;
  for (const code of Array.from(root.querySelectorAll<HTMLElement>("code:not([data-file-path])"))) {
    if (code.closest("pre, a, button")) continue;
    const ref = fileRefOf(code.textContent ?? "");
    if (!ref) continue;
    code.dataset.filePath = ref.path;
    if (ref.line) code.dataset.fileLine = String(ref.line);
    code.classList.add("md-file-link");
    code.tabIndex = 0;
    code.setAttribute("role", "button");
    code.setAttribute("aria-label", `Open ${ref.path}${ref.line ? ` at line ${ref.line}` : ""} in Files`);
  }
}

/** The file a click or key press on a decorated span asks to open. */
export function fileRefFromEvent(event: { target: EventTarget | null; key?: string }): FileRef | undefined {
  if (event.key !== undefined && event.key !== "Enter" && event.key !== " ") return undefined;
  const code = (event.target as Element | null)?.closest?.<HTMLElement>("code[data-file-path]");
  if (!code?.dataset.filePath) return undefined;
  const line = Number(code.dataset.fileLine);
  return line ? { path: code.dataset.filePath, line } : { path: code.dataset.filePath };
}
