// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { approximate, composite, noteAnchor, readNotes, readStrokes, readElementScrolls } from "../src/apps/annotate.js";
import { decodePng } from "../src/apps/review.js";
import { encodePng } from "../src/apps/rfb.js";
import { findChrome } from "../src/apps/screenshot.js";
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

test("several notes wear their numbers in the picture, where each one starts", () => {
  const notes = readNotes([
    { n: 1, words: "  Too small  ", selectors: ["#buy", 42, "x".repeat(400)], strokes: [{ tool: "box", points: [[40, 40], [90, 70]] }] },
    { n: 2, words: "Misaligned", strokes: [{ tool: "pen", points: [[40, 140], [160, 140]] }] },
  ]);
  assert.deepEqual(notes.map((note) => [note.n, note.words, note.selectors]), [[1, "Too small", ["#buy"]], [2, "Misaligned", []]]);
  assert.deepEqual(notes.map(noteAnchor), [{ x: 40, y: 40 }, { x: 40, y: 140 }]);
  const badges = notes.map((note) => ({ n: note.n, ...noteAnchor(note) }));
  const png = composite(black(200, 200), notes.flatMap((note) => note.strokes), { scale: 1 }, badges);
  // A pill of ink centred on each anchor, with the digit cut out of it in halo.
  assert.deepEqual(pixel(png, 40, 30), INK);
  assert.deepEqual(pixel(png, 40, 130), INK);
  const halo = (x: number, y: number) => { const d = decodePng(png); let n = 0; for (let j = y - 8; j <= y + 8; j++) for (let i = x - 8; i <= x + 8; i++) { const k = (j * d.width + i) * d.channels; if (d.pixels[k] === 255 && d.pixels[k + 1] === 255 && d.pixels[k + 2] === 255) n++; } return n; };
  assert.ok(halo(40, 40) > 0 && halo(40, 140) > 0, "each number is drawn inside its pill");
  // "1" is two segments and "2" is five, so they cannot be the same picture.
  assert.notEqual(halo(40, 40), halo(40, 140));
  // Without numbers, nothing is drawn at the anchors but the marks themselves.
  const plain = composite(black(200, 200), notes.flatMap((note) => note.strokes), { scale: 1 });
  assert.deepEqual(pixel(plain, 40, 30), [0, 0, 0]);
  assert.throws(() => readNotes([{ n: 0, strokes: [{ tool: "box", points: [[0, 0]] }] }]), /note number/);
  assert.throws(() => readNotes([]), /1 to 20 notes/);
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


test("annotated screenshots restore app panel scrolling beneath the marks", { skip: !findChrome() && "no Chrome/Chromium on this machine" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-panel-annotation-"));
  try {
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><style>
      body { margin:0; } #panel { position:absolute; left:200px; top:100px; width:600px; height:400px; overflow:auto; }
      #content { position:relative; height:2000px; } #target { position:absolute; left:100px; top:700px; width:100px; height:100px; background:blue; }
      </style><div id="panel"><div id="content"><div id="target"></div></div></div>`);
    const registry = new AppRegistry();
    const service = new AppService(registry, undefined, { start: async () => "t", has: () => true, close: () => {} }, { screenshots: { enabled: () => true } });
    const app = service.publish("s", dir, { version: 1, name: "Panel", views: [{ kind: "web", name: "App", source: { kind: "static", directory: "." } }] });
    const input = { appId: app.id, viewId: app.views[0]!.id, viewport: { width: 1280, height: 800 }, dpr: 1,
      elementScrolls: [{ selector: "#panel", x: 0, y: 600 }], strokes: [{ tool: "box", points: [[300, 200], [400, 300]] }] };
    const result = await service.annotate("s", input);
    const png = Buffer.from(result.image!.data, "base64");
    assert.deepEqual(pixel(png, 350, 250), [0, 0, 255], "the marked content is at the same viewport position");
    assert.deepEqual(pixel(png, 350, 200), INK, "the box surrounds that content");
    assert.equal(result.approximate, false);
    const missing = await service.annotate("s", { ...input, elementScrolls: [{ selector: "#gone", x: 0, y: 600 }] });
    assert.equal(missing.approximate, true, "a missing scroll container must not claim to match");
    assert.throws(() => readElementScrolls([{ selector: "#panel", x: 0, y: Infinity }]), /Invalid scroll/);
    assert.throws(() => readElementScrolls(Array(51).fill(input.elementScrolls[0])), /Invalid scroll/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// `scroll-behavior: smooth` must not leave the retake mid-scroll, with the
// marks placed for a position the picture isn't at.
test("annotated screenshots of a smooth-scrolling page keep the marks on what was marked", { skip: !findChrome() && "no Chrome/Chromium on this machine" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-smooth-annotation-"));
  try {
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><style>
      html { scroll-behavior:smooth; } body { margin:0; height:5000px; position:relative; }
      #target { position:absolute; left:100px; top:3000px; width:100px; height:100px; background:blue; }
      </style><div id="target"></div>`);
    const service = new AppService(new AppRegistry(), undefined, { start: async () => "t", has: () => true, close: () => {} }, { screenshots: { enabled: () => true } });
    const app = service.publish("s", dir, { version: 1, name: "Landing", views: [{ kind: "web", name: "App", source: { kind: "static", directory: "." } }] });
    const result = await service.annotate("s", { appId: app.id, viewId: app.views[0]!.id, viewport: { width: 800, height: 600 }, dpr: 1,
      scroll: { x: 0, y: 2800 }, strokes: [{ tool: "box", points: [[80, 2980], [220, 3120]] }] });
    const png = Buffer.from(result.image!.data, "base64");
    assert.deepEqual(pixel(png, 150, 250), [0, 0, 255], "the picture is at the scroll the user drew at");
    assert.deepEqual(pixel(png, 150, 180), INK, "the box surrounds the marked content");
    assert.equal(result.approximate, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
