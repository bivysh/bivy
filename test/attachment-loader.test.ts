import { test } from "node:test";
import assert from "node:assert/strict";
import { AttachmentDiskCache, AttachmentLoader } from "../packages/web/src/store/attachment-loader.js";

const bytes = { mimeType: "image/png", data: "YWJj" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

test("attachment loader prioritizes newest, limits concurrency, deduplicates and caches", async () => {
  const loader = new AttachmentLoader();
  const started: string[] = [];
  const finish = new Map<string, (value: typeof bytes) => void>();
  const load = (key: string) => () => new Promise<typeof bytes>((resolve) => {
    started.push(key);
    finish.set(key, resolve);
  });
  const old = loader.fetch("old", 1, load("old"));
  const middle = loader.fetch("middle", 2, load("middle"));
  const newest = loader.fetch("new", 3, load("new"));
  assert.equal(loader.fetch("new", 3, load("duplicate")), newest);
  await tick();
  assert.deepEqual(started, ["new", "middle"]);
  finish.get("new")!(bytes);
  await newest;
  await tick();
  assert.deepEqual(started, ["new", "middle", "old"]);
  finish.get("middle")!(bytes);
  finish.get("old")!(bytes);
  await Promise.all([old, middle]);
  assert.deepEqual(await loader.fetch("new", 3, () => { throw Error("cache miss"); }), bytes);
});

test("failed attachment fetches can retry and queued requests can be promoted", async () => {
  const loader = new AttachmentLoader();
  assert.equal(await loader.fetch("retry", 0, async () => { throw Error("offline"); }), null);
  assert.deepEqual(await loader.fetch("retry", 0, async () => bytes), bytes);
  const order: string[] = [];
  const first = loader.fetch("first", 1, async () => { order.push("first"); return bytes; });
  const second = loader.fetch("second", 2, async () => { order.push("second"); return bytes; });
  loader.fetch("first", 10, async () => null);
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
});

test("attachment memory cache is bounded and least-recently-used", async () => {
  const loader = new AttachmentLoader();
  const large = { ...bytes, data: "a".repeat(20 * 1024 * 1024) };
  await loader.fetch("old", 0, async () => large);
  await loader.fetch("new", 0, async () => large);
  let reloaded = false;
  await loader.fetch("old", 0, async () => { reloaded = true; return bytes; });
  assert.equal(reloaded, true);
  assert.equal(await loader.fetch("new", 0, async () => null), large);
});

test("disk cache degrades gracefully when browser storage is unavailable", async () => {
  const cache = new AttachmentDiskCache();
  assert.equal(await cache.get("node", "hash"), null);
  cache.put("node", "hash", bytes);
  await cache.clear();
});
