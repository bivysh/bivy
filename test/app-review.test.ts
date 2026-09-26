// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AppRegistry } from "../src/apps/registry.js";
import { AppService, type ReviewSink } from "../src/apps/service.js";
import { reviewHint, shouldReview, visualChange } from "../src/apps/review.js";
import { encodePng } from "../src/apps/rfb.js";
import type { AppReview, ReviewCardMode } from "../src/apps/types.js";

const terminals = { start: async () => "t", has: () => true, close: () => {} };
/** A 100×100 page with `changed` rows painted over the top. */
const page = (changed: number) => {
  const rgb = Buffer.alloc(100 * 100 * 3, 255);
  rgb.fill(0, 0, changed * 100 * 3);
  return encodePng(100, 100, rgb);
};

test("review triggers: presented, asked, or a run whose preview visibly changed — by mode and mute", () => {
  const cases: [Parameters<typeof shouldReview>[0], boolean][] = [
    [{ trigger: "run", mode: "ready", muted: false, revisionChanged: true, change: 0.05 }, true],
    [{ trigger: "run", mode: "ready", muted: false, revisionChanged: true, change: 0.0001 }, false], // a caret, not a change
    [{ trigger: "run", mode: "every", muted: false, revisionChanged: true, change: 0.0001 }, true],
    [{ trigger: "run", mode: "every", muted: false, revisionChanged: true, change: 0 }, false], // backend-only
    [{ trigger: "run", mode: "ready", muted: false, revisionChanged: false, change: 0.05 }, false],
    [{ trigger: "run", mode: "ready", muted: false, revisionChanged: true, change: undefined }, false], // no baseline: can't prove it
    [{ trigger: "run", mode: "off", muted: false, revisionChanged: true, change: 1 }, false],
    [{ trigger: "run", mode: "ready", muted: true, revisionChanged: true, change: 1 }, false],
    [{ trigger: "present", mode: "ready", muted: false, revisionChanged: false }, true],
    [{ trigger: "present", mode: "off", muted: false, revisionChanged: true }, false],
    [{ trigger: "present", mode: "every", muted: true, revisionChanged: true }, false],
    [{ trigger: "asked", mode: "off", muted: true, revisionChanged: false }, true],
  ];
  for (const [input, expected] of cases) assert.equal(shouldReview(input), expected, JSON.stringify(input));
  assert.equal(visualChange(page(0), page(0)), 0);
  assert.equal(visualChange(page(0), page(10)), 0.1);
});

test("a run makes one card for a visible change, none for a backend-only one, and updates it in place", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-review-test-"));
  try {
    fs.mkdirSync(path.join(dir, "dist")); fs.writeFileSync(path.join(dir, "dist/index.html"), "<h1>v0</h1>");
    let look = 0;
    let shots = 0;
    const take = async (views: { view: { id: string; name: string } }[], _request: unknown, outDir: string) => {
      fs.mkdirSync(outDir, { recursive: true }); shots++;
      const file = path.join(outDir, "shot.png"); fs.writeFileSync(file, page(look));
      return [{ viewId: views[0]!.view.id, view: views[0]!.view.name, width: 390, theme: "light" as const, file }];
    };
    const published: AppReview[] = [];
    const expired: AppReview[] = [];
    const hash = (png?: Buffer) => png && { hash: createHash("sha256").update(png).digest("hex"), size: png.length, width: 100, height: 100 };
    const sink: ReviewSink = {
      publish: (review, images) => { const card = { ...review, ...(images.shot ? { shot: hash(images.shot) } : {}), ...(images.before ? { before: hash(images.before) } : {}) }; published.push(card); return card; },
      expire: (review) => { expired.push(review); },
    };
    const registry = new AppRegistry();
    const service = new AppService(registry, undefined, terminals, { screenshots: { enabled: () => true, take: take as never }, reviews: sink, settleMs: 0 });
    const app = service.publish("s", dir, { version: 1, name: "Storefront", views: [{ kind: "web", name: "Site", source: { kind: "static", directory: "dist" } }] });
    const edit = (html: string, pixels: number) => { fs.writeFileSync(path.join(dir, "dist/index.html"), html); look = pixels; service.turnChanged("s"); };
    const settle = () => new Promise((r) => setTimeout(r, 20));

    // Backend-only: files change, pixels don't.
    service.runStarted("s"); await settle();
    edit("<h1>v0</h1><!-- api -->", 0);
    assert.equal(await service.runEnded("s"), undefined);
    assert.equal(published.length, 0);

    // A visible change: exactly one card, with the page before the run.
    service.runStarted("s"); await settle();
    const before = shots;
    edit("<h1>v1</h1>", 20);
    const card = await service.runEnded("s");
    assert.equal(published.length, 1);
    assert.equal(card?.trigger, "run");
    assert.ok(card?.shot && card.before && card.shot.hash !== card.before.hash);
    assert.equal(shots, before + 1, "the card reuses the run's after-turn screenshot");

    // Presented mid-run, then changed again: the same card, updated.
    service.runStarted("s"); await settle();
    edit("<h1>v2</h1>", 40);
    const presented = await service.present("s", { note: "New pay button" });
    edit("<h1>v3</h1>", 60);
    const ended = await service.runEnded("s");
    assert.equal(ended?.id, presented.review?.id);
    assert.equal(ended?.note, "New pay button");
    assert.deepEqual(expired.map((review) => review.id), [card!.id], "a newer card retires the older card's pictures");

    // Off: no card on its own, and present says so. Show me still works.
    service.setReviewMode("s", app.id, "off" satisfies ReviewCardMode);
    const count = published.length;
    service.runStarted("s"); await settle();
    edit("<h1>v4</h1>", 80);
    assert.equal(await service.runEnded("s"), undefined);
    assert.match((await service.present("s", {})).message, /off/);
    assert.equal(published.length, count);
    assert.equal((await service.present("s", { trigger: "asked" })).review?.trigger, "asked");

    // Mute: nothing more this run.
    service.setReviewMode("s", app.id, "ready");
    service.runStarted("s"); await settle();
    service.mute("s");
    edit("<h1>v5</h1>", 90);
    assert.equal(await service.runEnded("s"), undefined);
    assert.equal(published.length, count + 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the finished notification's hint names the card, never its image", () => {
  const review: AppReview = { id: "review-0123456789abcdef", sessionId: "s", appId: "a".repeat(32), viewId: "b".repeat(32), name: "Storefront", view: "Site", path: "/checkout", trigger: "run", at: 1,
    shot: { hash: "c".repeat(64), size: 10, width: 780, height: 1688 }, before: { hash: "d".repeat(64), size: 10, width: 780, height: 1688 } };
  const hint = reviewHint(review);
  assert.deepEqual(hint.review, { appId: review.appId, viewId: review.viewId, reviewId: review.id });
  assert.doesNotMatch(JSON.stringify(hint), /c{64}|d{64}|png|base64/i);
});
