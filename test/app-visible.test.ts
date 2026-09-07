import assert from "node:assert/strict";
import { onAppVisible } from "../packages/web/src/onAppVisible.js";

class Page extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}
const page = new Page();
const view = new EventTarget();
let count = 0;
let osBadge = 14;
const updates: number[] = [];
let stop = onAppVisible(() => { osBadge = count; updates.push(count); }, page, view);

// The inbox stays empty throughout suspension; there is no React dependency
// change to trigger the old badge effect. Resume must still clear a stale 14.
page.visibilityState = "hidden";
page.dispatchEvent(new Event("visibilitychange"));
view.dispatchEvent(new Event("focus"));
assert.equal(osBadge, 14, "hidden lifecycle events do not reconcile");
page.visibilityState = "visible";
page.dispatchEvent(new Event("visibilitychange"));
assert.equal(osBadge, 0, "resume reconciles even an unchanged zero count");
osBadge = 14;
view.dispatchEvent(new Event("pageshow"));
assert.equal(osBadge, 0, "back/forward cache restoration reconciles");
osBadge = 14;
view.dispatchEvent(new Event("focus"));
assert.equal(osBadge, 0, "focus retries a stale badge");
assert.deepEqual(updates, [0, 0, 0]);

stop();
count = 3;
stop = onAppVisible(() => { osBadge = count; updates.push(count); }, page, view);
page.dispatchEvent(new Event("visibilitychange"));
assert.equal(osBadge, 3, "new subscription uses the current nonzero count");
assert.deepEqual(updates, [0, 0, 0, 3], "old subscription was removed");
stop();
page.dispatchEvent(new Event("visibilitychange"));
view.dispatchEvent(new Event("pageshow"));
view.dispatchEvent(new Event("focus"));
assert.equal(updates.length, 4, "cleanup removes all listeners");
console.log("app visibility reconciliation tests passed");
