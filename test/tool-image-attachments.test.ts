// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  autoAttachToolImagesEnabled,
  setConfiguredAutoAttachToolImages,
  MAX_PASSIVE_IMAGES_PER_TURN,
  MAX_PASSIVE_IMAGE_BYTES_PER_TURN,
  PassiveImageBudget,
} from "../src/harness/tool-image-attachments.js";

test("autoAttachToolImagesEnabled is off by default", () => {
  setConfiguredAutoAttachToolImages(undefined);
  delete process.env.BIVY_AUTO_ATTACH_TOOL_IMAGES;
  assert.equal(autoAttachToolImagesEnabled(), false);
});

test("autoAttachToolImagesEnabled follows the configured node setting", () => {
  delete process.env.BIVY_AUTO_ATTACH_TOOL_IMAGES;
  try {
    setConfiguredAutoAttachToolImages(true);
    assert.equal(autoAttachToolImagesEnabled(), true);
    setConfiguredAutoAttachToolImages(false);
    assert.equal(autoAttachToolImagesEnabled(), false);
    // Only a strict `true` turns it on — a truthy-but-not-boolean settings.json
    // value (e.g. a stray string) must never accidentally enable it.
    setConfiguredAutoAttachToolImages("yes");
    assert.equal(autoAttachToolImagesEnabled(), false);
  } finally {
    setConfiguredAutoAttachToolImages(undefined);
  }
});

test("BIVY_AUTO_ATTACH_TOOL_IMAGES env overrides the node setting (plain truthiness)", () => {
  setConfiguredAutoAttachToolImages(false);
  try {
    process.env.BIVY_AUTO_ATTACH_TOOL_IMAGES = "1";
    assert.equal(autoAttachToolImagesEnabled(), true, "any non-empty value enables, even when the setting is off");
    process.env.BIVY_AUTO_ATTACH_TOOL_IMAGES = "";
    assert.equal(autoAttachToolImagesEnabled(), false, "empty string does not count as set");
  } finally {
    delete process.env.BIVY_AUTO_ATTACH_TOOL_IMAGES;
    setConfiguredAutoAttachToolImages(undefined);
  }
});

test("PassiveImageBudget admits up to the count cap, then drops", () => {
  const budget = new PassiveImageBudget();
  for (let i = 0; i < MAX_PASSIVE_IMAGES_PER_TURN; i++) {
    assert.equal(budget.admit(10), true, `image ${i} should be admitted`);
  }
  assert.equal(budget.hasDropped, false);
  assert.equal(budget.admit(10), false, "the (cap + 1)th image should be dropped");
  assert.equal(budget.hasDropped, true);
  assert.match(budget.droppedSummary(), /dropped 1 tool-produced image/);
});

test("PassiveImageBudget admits up to the byte cap, then drops", () => {
  const budget = new PassiveImageBudget();
  const half = Math.floor(MAX_PASSIVE_IMAGE_BYTES_PER_TURN / 2);
  assert.equal(budget.admit(half), true);
  assert.equal(budget.admit(half), true);
  // One more byte tips it over the total cap even though the count cap has room.
  assert.equal(budget.admit(2), false);
  assert.match(budget.droppedSummary(), /dropped 1 tool-produced image\(s\) totaling 2 bytes/);
});

test("PassiveImageBudget.droppedSummary is empty until something is dropped", () => {
  const budget = new PassiveImageBudget();
  assert.equal(budget.droppedSummary(), "");
  budget.admit(10);
  assert.equal(budget.droppedSummary(), "", "an admitted image is not a drop");
});
