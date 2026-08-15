// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../packages/web/src/", import.meta.url);

const SURFACES = [
  ["components/SessionList.tsx", 'className="field session-search"'],
  ["components/Settings.tsx", 'className="field settings-search"'],
  ["components/ScheduleSheet.tsx", 'className="field"'],
  ["components/FollowupQueue.tsx", 'className="field followup-edit-input"'],
  ["components/RunTaskSheet.tsx", 'className="field"'],
] as const;

test("search and scheduling fields use the canonical field shell", async () => {
  for (const [path, className] of SURFACES) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    expect(source, path).toContain(className);
    expect(source, path).not.toContain("schedule-input");
  }
});

test("surface field classes only own layout", async () => {
  const css = await readFile(new URL("styles.css", ROOT), "utf8");
  expect(css).toContain(".field, .picker-search {");
  expect(css).not.toContain(".schedule-input");
  expect(css).toContain(".picker-search { margin-bottom: 6px; }");
  for (const selector of [".session-search", ".settings-search", ".followup-edit-input"]) {
    const start = css.indexOf(`${selector} {`);
    const rule = css.slice(start, css.indexOf("}", start));
    expect(rule, selector).not.toMatch(/(?:background|border(?!-collapse)|border-radius|color|font-size|font-family)\s*:/);
  }
});
