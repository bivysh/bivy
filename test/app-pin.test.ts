// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppRegistry } from "../src/apps/registry.js";
import { AppService, type PinSink } from "../src/apps/service.js";
import { PIN_CHANGE, pngSize, regionChange } from "../src/apps/review.js";
import { encodePng } from "../src/apps/rfb.js";
import type { AppPin } from "../src/apps/types.js";

const terminals = { start: async () => "t", has: () => true, close: () => {} };
/** A 390×200 page (at 1×) with a band painted across rows `from`–`to`. */
const page = (from = 0, to = 0) => {
  const rgb = Buffer.alloc(390 * 200 * 3, 255);
  if (to > from) rgb.fill(0, from * 390 * 3, to * 390 * 3);
  return encodePng(390, 200, rgb);
};

test("a pin's change is measured where it was marked, not across the page", () => {
  // A change far from the mark leaves the marked region untouched.
  const marked = { x: 10, y: 10, width: 60, height: 20 };
  assert.equal(regionChange(page(), page(150, 180), marked, 1), 0);
  assert.ok(regionChange(page(), page(12, 26), marked, 1)! > PIN_CHANGE);
  // A page that grew or shrank says nothing about the marked spot.
  assert.equal(regionChange(page(), encodePng(390, 100, Buffer.alloc(390 * 100 * 3, 255)), marked, 1), undefined);
  // A region outside the picture cannot be judged either.
  assert.equal(regionChange(page(), page(0, 50), { x: 500, y: 0, width: 10, height: 10 }, 1), undefined);
});

test("marks sent to the agent become a pin, which a later run answers from evidence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-pin-test-"));
  try {
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "dist/index.html"), "<h1>v0</h1>");
    let look = page();
    let missing: string[] = [];
    const take = async (views: { view: { id: string; name: string } }[], request: { selectors?: string[] }, outDir: string) => {
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, "shot.png");
      fs.writeFileSync(file, look);
      return [{ viewId: views[0]!.view.id, view: views[0]!.view.name, width: 390, theme: "light" as const, file,
        ...(request.selectors ? { missing: request.selectors.filter((selector) => missing.includes(selector)) } : {}) }];
    };
    const published: AppPin[] = [];
    const pictures: Buffer[] = [];
    const pins: PinSink = { publish: (pin, image) => { published.push(pin); if (image) pictures.push(image); return pin; } };
    const registry = new AppRegistry();
    const service = new AppService(registry, undefined, terminals, { screenshots: { enabled: () => true, take: take as never }, pins, settleMs: 0 });
    const app = service.publish("s", dir, { version: 1, name: "Storefront", views: [{ kind: "web", name: "Site", source: { kind: "static", directory: "dist" } }] });
    const view = app.views[0]!;
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const mark = async (selectors: string[]) => {
      await service.annotate("s", { appId: app.id, viewId: view.id, viewport: { width: 390, height: 200 }, selectors,
        strokes: [{ tool: "box", points: [[10, 10], [70, 30]] }] });
      return service.pin("s", { appId: app.id, viewId: view.id, words: "This button is too small" });
    };
    const edit = (html: string, shot: Buffer) => {
      fs.writeFileSync(path.join(dir, "dist/index.html"), html);
      look = shot;
      service.turnChanged("s");
    };

    // Marks only become a pin when they are sent, and the pin starts open.
    const { pin } = await mark(["#buy"]);
    assert.equal(pin.state, "open");
    assert.equal(pin.words, "This button is too small");
    assert.deepEqual(pin.selectors, ["#buy"]);
    assert.deepEqual(pin.region, { x: 10, y: 10, width: 60, height: 20 });
    // The card shows what they marked, not the whole page it sat on.
    assert.deepEqual(pngSize(pictures[0]!), { width: 94, height: 54 });
    // The picture was handed over with the pin, so it cannot be claimed twice.
    assert.throws(() => service.pin("s", { appId: app.id, viewId: view.id, words: "again" }), /no longer held/);

    // A run that changes the page somewhere else leaves the pin open: it has
    // not been answered.
    service.runStarted("s"); await settle();
    edit("<h1>v1</h1>", page(150, 180));
    await service.runEnded("s");
    assert.equal(published.at(-1)!.state, "open");

    // A run that changes the marked pixels answers it.
    service.runStarted("s"); await settle();
    edit("<h1>v2</h1>", page(12, 26));
    await service.runEnded("s");
    assert.equal(published.at(-1)!.state, "changed");
    assert.equal(published.at(-1)!.id, pin.id, "the same pin, moved; never a second card");

    // What a pin named leaving the page is its own answer.
    const second = (await mark(["#gone"])).pin;
    missing = ["#gone"];
    service.runStarted("s"); await settle();
    edit("<h1>v3</h1>", page(150, 180));
    await service.runEnded("s");
    assert.equal(published.filter((item) => item.id === second.id).at(-1)!.state, "gone");

    // The person's own verdict wins, and can be taken back.
    assert.equal(service.setPinState("s", pin.id, "done").pin.state, "done");
    assert.equal(service.setPinState("s", pin.id, "open").pin.state, "open");
    assert.throws(() => service.setPinState("s", "pin-missing", "done"), /no longer held/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
