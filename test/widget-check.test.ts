// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// A widget whose script cannot parse shows and does nothing. The check that
// catches it needs no browser, names the file's own line, and leaves module
// scripts and data blocks to the browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkWidgetScripts } from "../src/widgets/check.js";
import { shootWidget } from "../src/widgets/shot.js";

const BROKEN = `<!doctype html>
<form id="f"></form>
<script>
  bivy.ready(function () {
    bivy.send("Standup — " + today + "\\nYesterday: " + (value.yesterday || "—");
  });
</script>`;

test("a script that does not parse is reported at its line in the file", () => {
  assert.deepEqual(checkWidgetScripts(BROKEN, "standup.html"), ["SyntaxError: missing ) after argument list (standup.html line 5)"]);
  assert.deepEqual(checkWidgetScripts('<script>var ok = 1;</script><script type="module">import x from "y";</script><script type="application/json">{not js</script><script src="https://cdn.example/x.js"></script>'), []);
});

test("without a browser, a shot still reports what the script check found", async () => {
  const noBrowser = async () => { throw new Error("No Chrome or Chromium found on this machine. Install one, or set BIVY_CHROME to its path."); };
  const result = await shootWidget({ html: BROKEN }, fs.mkdtempSync(path.join(os.tmpdir(), "bivy-shot-")), noBrowser);
  assert.deepEqual(result.shots, []);
  assert.match(result.note ?? "", /No Chrome or Chromium/);
  assert.match(result.errors[0] ?? "", /missing \) after argument list \(widget line 5\)/);
});
