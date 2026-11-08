// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// Which inline code in an agent reply opens a file (packages/web/src/filePaths.ts):
// workspace-relative paths, with an optional line; not method calls, versions,
// URLs, absolute paths or paths that climb out with `..`.
import { strict as assert } from "node:assert";
import test from "node:test";

import { fileRefOf } from "../packages/web/src/filePaths.js";

test("relative paths open, with their line; other inline code stays code", () => {
  assert.deepEqual(fileRefOf("src/server.ts"), { path: "src/server.ts" });
  assert.deepEqual(fileRefOf("./packages/web/src/App.tsx:120:4"), { path: "packages/web/src/App.tsx", line: 120 });
  assert.deepEqual(fileRefOf("README.md"), { path: "README.md" });
  assert.deepEqual(fileRefOf("config/app.json"), { path: "config/app.json" });
  for (const code of ["res.json", "JSON.parse", "v1.2", "pnpm run lint", "https://x.dev/a.ts", "/etc/passwd.txt", "~/notes.md", "../secret.md", "a/../b.ts", "src/", "src/server"]) {
    assert.equal(fileRefOf(code), undefined, code);
  }
});
