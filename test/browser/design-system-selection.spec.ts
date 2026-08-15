// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../packages/web/src/", import.meta.url);

test("choice controls use the canonical selectable state", async () => {
  for (const path of [
    "components/Rulesets.tsx",
    "components/VoiceSettings.tsx",
    "components/Settings.tsx",
    "components/SessionSettings.tsx",
    "components/Segmented.tsx",
  ]) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    expect(source, path).toContain("selectable");
    expect(source, path).not.toMatch(/className=.*(?:seg-btn|ruleset-chip)(?:[ `"}])/);
  }
});

test("legacy segmented and ruleset choice recipes are removed", async () => {
  const css = await readFile(new URL("styles.css", ROOT), "utf8");
  expect(css).toContain('.selectable[aria-checked="true"]');
  expect(css).toContain('.selectable[aria-disabled="true"]');
  expect(css).not.toMatch(/\.(?:seg-btn|ruleset-chip)(?:[ .:{[])/);
});
