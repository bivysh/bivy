import assert from "node:assert/strict";
import test from "node:test";
import { sessionDateGroup } from "../packages/web/src/sessionPresentation.js";

const now = new Date(2026, 7, 13, 15, 0);

test("session dates group into familiar conversation buckets", () => {
  assert.equal(sessionDateGroup(new Date(2026, 7, 13, 1, 0), now), "Today");
  assert.equal(sessionDateGroup(new Date(2026, 7, 12, 23, 0), now), "Yesterday");
  assert.equal(sessionDateGroup(new Date(2026, 7, 8, 12, 0), now), "Previous 7 days");
  assert.equal(sessionDateGroup(new Date(2026, 7, 1, 12, 0), now), "Older");
});

test("missing and malformed dates group quietly as older", () => {
  assert.equal(sessionDateGroup(undefined, now), "Older");
  assert.equal(sessionDateGroup("not-a-date", now), "Older");
});
