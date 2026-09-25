// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { AppRegistry } from "../src/apps/registry.js";
import { AppService } from "../src/apps/service.js";
import { findChrome } from "../src/apps/screenshot.js";

const terminals = { start: async () => "t", has: () => true, close: () => {} };

test("agent screenshots are refused while the machine setting is off", async () => {
  const service = new AppService(new AppRegistry(), undefined, terminals);
  await assert.rejects(service.shot("s", undefined, {}), /bivy config set sessions\.appScreenshots true/);
});

// Real browser, real pages: widths map to image sizes, and the theme is
// emulated for the page (prefers-color-scheme), not just recorded.
test("screenshots cover every web view at each width and theme", { skip: !findChrome() && "no Chrome/Chromium on this machine" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-shot-test-"));
  const schemes: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/seen")) { schemes.push(new URL(req.url, "http://x").searchParams.get("dark")!); res.end(); return; }
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Live</title><h1>Live</h1><script>fetch("/seen?dark="+matchMedia("(prefers-color-scheme: dark)").matches)</script>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    fs.mkdirSync(path.join(dir, "dist")); fs.writeFileSync(path.join(dir, "dist/index.html"), "<h1>Static</h1>");
    const registry = new AppRegistry();
    const service = new AppService(registry, undefined, terminals, { screenshots: { enabled: () => true } });
    service.publish("s", dir, { version: 1, name: "Both", views: [
      { kind: "web", name: "Live", source: { kind: "service", port: (server.address() as { port: number }).port } },
      { kind: "web", name: "Static", source: { kind: "static", directory: "dist" } },
      { kind: "terminal", name: "Shell", command: "sh" },
    ] });
    const { shots } = await service.shot("s", undefined, { widths: [390, 1280], themes: ["light", "dark"] });
    assert.deepEqual(shots.map((s) => [s.view, s.width, s.theme]), [
      ["Live", 390, "light"], ["Live", 390, "dark"], ["Live", 1280, "light"], ["Live", 1280, "dark"],
      ["Static", 390, "light"], ["Static", 390, "dark"], ["Static", 1280, "light"], ["Static", 1280, "dark"],
    ]);
    for (const shot of shots) {
      const png = fs.readFileSync(shot.file);
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      // Phone widths render at 2x, like a phone.
      assert.equal(png.readUInt32BE(16), shot.width < 600 ? shot.width * 2 : shot.width);
    }
    assert.deepEqual(schemes, ["false", "true", "false", "true"]);
    await assert.rejects(service.shot("s", undefined, { widths: [100] }), /between 240 and 2560/);
  } finally { server.close(); server.closeAllConnections(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Compare keeps the last few shots per view, labelled with the revision they show", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-compare-test-"));
  try {
    fs.mkdirSync(path.join(dir, "dist")); fs.writeFileSync(path.join(dir, "dist/index.html"), "<h1>v0</h1>");
    const registry = new AppRegistry();
    let n = 0;
    const take = async (views: { view: { id: string; name: string } }[], request: { path: string }, outDir: string) => {
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, "shot.png"); fs.writeFileSync(file, `png-${n++}-${request.path}`);
      return [{ viewId: views[0]!.view.id, view: views[0]!.view.name, width: 390, theme: "light" as const, file }];
    };
    const service = new AppService(registry, undefined, terminals, { screenshots: { enabled: () => true, take: take as never } });
    const id = service.publish("s", dir, { version: 1, name: "Site", views: [{ kind: "web", name: "Site", source: { kind: "static", directory: "dist" } }] }).views[0]!.id;
    registry.getView(id)!.lastPath = "/ledger";
    await service.capture([id]);
    for (let turn = 1; turn <= 5; turn++) {
      fs.writeFileSync(path.join(dir, "dist/index.html"), `<h1>v${turn}</h1>`);
      registry.touch("s");
      await service.capture([id]);
    }
    const shots = registry.getView(id)!.shots!;
    assert.deepEqual(shots.map((s) => [s.revision, s.png.toString()]), [[2, "png-2-/ledger"], [3, "png-3-/ledger"], [4, "png-4-/ledger"], [5, "png-5-/ledger"]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
