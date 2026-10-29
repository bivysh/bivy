// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// `bivy widget shot`: the agent that wrote a widget sees it, in the app's frame
// and runtime, with every error it raised — including one thrown in its ready
// callback and a plugin tool call that failed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findChrome } from "../src/apps/screenshot.js";
import { shootWidget } from "../src/widgets/shot.js";

test("a widget is shot at each width and theme, with its data, live tool data and errors", { skip: !findChrome() && "no Chrome/Chromium on this machine" }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-widget-shot-"));
  const calls: string[] = [];
  const html = `<p id="q"></p><script>
    bivy.ready(function () {
      document.getElementById('q').textContent = bivy.data.question;
      bivy.call('status', {}).then(function (r) { document.body.append(r.state); });
      bivy.call('missing', {});
      notAFunction();
    });
  </script>`;
  const result = await shootWidget({
    html,
    data: { question: "Which?" },
    widths: [390, 1024],
    themes: ["light", "dark"],
    callTool: async (name) => {
      calls.push(name);
      if (name === "status") return { structuredContent: { state: "green" } };
      throw new Error(`No plugin tool called "${name}".`);
    },
  }, out);
  assert.deepEqual(result.shots.map(({ width, theme }) => `${width}-${theme}`), ["390-light", "390-dark", "1024-light", "1024-dark"]);
  for (const shot of result.shots) assert.ok(fs.statSync(shot.file).size > 1000);
  assert.deepEqual([...new Set(calls)].sort(), ["missing", "status"]);
  assert.ok(result.errors.includes("notAFunction is not defined"), result.errors.join("\n"));
  assert.ok(result.errors.some((error) => /bivy\.call\("missing"\) failed: No plugin tool called "missing"/.test(error)), result.errors.join("\n"));
  assert.ok((result.height ?? 0) > 0);
});

test("the shot server answers only under its secret path, so nothing else can call a tool", async () => {
  const calls: string[] = [];
  let status = 0;
  let page = "";
  await shootWidget({ html: "<p>hi</p>", callTool: async (name) => { calls.push(name); return {}; } }, os.tmpdir(), async (views, options) => {
    const port = (views[0]!.target as { port: number }).port;
    status = (await fetch(`http://127.0.0.1:${port}/__tool`, { method: "POST", body: JSON.stringify({ name: "status" }) })).status;
    page = await (await fetch(`http://127.0.0.1:${port}${options.path}`)).text();
    return [];
  });
  assert.equal(status, 404);
  assert.deepEqual(calls, []);
  assert.match(page, /<iframe id="frame"/, "the harness is served under the path the shooter is given");
});

