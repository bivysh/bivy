// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelSelectionAvailable } from "../packages/web/src/modelSelection.js";

test("unknown model-list scope cannot override an explicit unsupported capability", () => {
  assert.equal(modelSelectionAvailable("fixture-acp", false, null, [{ id: "a" }]), false);
  assert.equal(modelSelectionAvailable("fixture-acp", true, null, []), true);
  assert.equal(modelSelectionAvailable("fixture-acp", undefined, null, []), true);
});
