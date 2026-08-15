// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../packages/web/src/", import.meta.url);

test("session and run identity use the canonical neutral SourceMark", async () => {
  const sourceMark = await readFile(new URL("components/SourceMark.tsx", ROOT), "utf8");
  expect(sourceMark).toContain("status?: StatusDotState");
  expect(sourceMark).toContain("<StatusDot status={status}");

  for (const path of ["components/SessionList.tsx", "components/RunPill.tsx"]) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    expect(source, path).toContain("<SourceMark");
    expect(source, path).not.toContain("session-mark");
    expect(source, path).not.toContain("run-pill-glyph");
  }
});

test("legacy source-mark shells are removed", async () => {
  const css = await readFile(new URL("styles.css", ROOT), "utf8");
  expect(css).toContain(".source-mark.has-status .status-dot");
  expect(css).not.toMatch(/\.(?:session-mark|run-pill-glyph)(?:[ .:{[])/);
});
