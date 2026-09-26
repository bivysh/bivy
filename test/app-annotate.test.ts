// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { approximate, composite, readStrokes } from "../src/apps/annotate.js";
import { decodePng } from "../src/apps/review.js";
import { encodePng } from "../src/apps/rfb.js";
import { AppRegistry } from "../src/apps/registry.js";
import { AppService } from "../src/apps/service.js";

const black = (w: number, h: number) => encodePng(w, h, Buffer.alloc(w * h * 3));
const pixel = (png: Buffer, x: number, y: number) => { const img = decodePng(png); const i = (y * img.width + x) * img.channels; return [...img.pixels.subarray(i, i + 3)]; };
const INK = [0xff, 0x2d, 0x78];
const HALO = [0xff, 0xff, 0xff];

test("marks are composited in page coordinates, scaled to the picture, over a halo", () => {
  // A pen stroke and a box, drawn scrolled 100px down, on a 2× picture.
  const png = composite(black(200, 200), [
    { tool: "pen", points: [[10, 110], [90, 110]] },
    { tool: "box", points: [[20, 130], [80, 170]] },
  ], { scale: 2, offset: { x: 0, y: 100 } });
  assert.deepEqual(pixel(png, 100, 20), INK); // pen: (50,110) → (100,20)
  assert.deepEqual(pixel(png, 100, 25), HALO); // just outside the 4px mark: its halo
  assert.deepEqual(pixel(png, 100, 60), INK); // box top edge at y=130 → 60
  assert.deepEqual(pixel(png, 100, 100), [0, 0, 0]); // a box is an outline, not a fill
  assert.deepEqual(pixel(png, 190, 190), [0, 0, 0]);
  assert.throws(() => readStrokes([{ tool: "laser", points: [[0, 0]] }]), /Invalid mark/);
  assert.throws(() => readStrokes([]), /at least one/);
});

test("a retaken picture is approximate when the page held state or couldn't scroll there; exact frames never are", () => {
  assert.equal(approximate("retake", {}, true), false);
  for (const signal of ["storage", "cookies", "interacted", "open", "edited"]) assert.equal(approximate("retake", { [signal]: true }, true), true, signal);
  assert.equal(approximate("retake", {}, false), true);
  assert.equal(approximate("exact", { storage: true, interacted: true }, false), false);
});

test("drawing on a preview: a retake with the page's state is labelled approximate; Compare is exact; screenshots off sends no picture", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-annotate-test-"));
  try {
    fs.mkdirSync(path.join(dir, "dist")); fs.writeFileSync(path.join(dir, "dist/index.html"), "<h1>Bag</h1>");
    let enabled = true;
    const requests: unknown[] = [];
    const take = async (views: { view: { id: string; name: string } }[], request: { scroll?: { x: number; y: number } }, outDir: string) => {
      requests.push(request);
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, "shot.png"); fs.writeFileSync(file, black(780, 1688));
      return [{ viewId: views[0]!.view.id, view: views[0]!.view.name, width: 390, theme: "light" as const, file, scroll: request.scroll }];
    };
    const registry = new AppRegistry();
    const service = new AppService(registry, undefined, { start: async () => "t", has: () => true, close: () => {} }, { screenshots: { enabled: () => enabled, take: take as never } });
    const app = service.publish("s", dir, { version: 1, name: "Storefront", views: [{ kind: "web", name: "Site", source: { kind: "static", directory: "dist" } }] });
    const base = { appId: app.id, viewId: app.views[0]!.id, path: "/checkout", viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 300 }, dpr: 2, strokes: [{ tool: "pen", points: [[10, 320], [60, 320]] }] };

    const plain = await service.annotate("s", base);
    assert.equal(plain.approximate, false);
    assert.equal(plain.image?.width, 780);
    assert.deepEqual(requests[0], { widths: [390], themes: ["light"], path: "/checkout", height: 844, scale: 2, scroll: { x: 0, y: 300 } });
    assert.deepEqual(pixel(Buffer.from(plain.image!.data, "base64"), 60, 40), INK); // (30,320) scrolled 300 → (30,20) → 2×
    assert.equal((await service.annotate("s", { ...base, signals: { storage: true } })).approximate, true);

    registry.getView(base.viewId)!.shots = [{ revision: 0, at: 0, png: black(780, 1688) }];
    const compared = await service.annotate("s", { ...base, compare: 0, scroll: undefined, signals: { storage: true } });
    assert.equal(compared.approximate, false);
    assert.equal(requests.length, 2, "Compare draws on the kept frame; no new picture");

    enabled = false;
    assert.deepEqual(await service.annotate("s", base), { approximate: false, screenshotsOff: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
