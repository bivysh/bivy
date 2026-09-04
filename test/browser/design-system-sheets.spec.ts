// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../packages/web/src/", import.meta.url);

test("action menus compose the canonical Sheet", async () => {
  for (const path of ["components/GithubPill.tsx", "components/RunPill.tsx"]) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    expect(source, path).toContain("<Sheet");
    expect(source, path).toContain('variant="action"');
    expect(source, path).not.toContain("action-sheet");
  }
});

test("the canonical Sheet owns action-menu shells", async () => {
  const source = await readFile(new URL("components/Sheet.tsx", ROOT), "utf8");
  const css = await readFile(new URL("styles.css", ROOT), "utf8");
  expect(source).toContain('variant?: "default" | "action"');
  expect(css).toContain('.sheet[data-variant="action"] .sheet-body');
  expect(css).not.toMatch(/\.action-sheet(?:[ .:{[])/);
});

test("forking consumes the sheet history entry before navigating", async () => {
  const source = await readFile(new URL("components/ForkSheet.tsx", ROOT), "utf8");
  const dismiss = source.indexOf("dismiss(() => {");
  const fork = source.indexOf("controller.forkSession", dismiss);

  // Sheet's PWA Back sentinel must be gone before forkSession navigates. If the
  // order is reversed, unmount cleanup returns the app to the source session.
  expect(dismiss).toBeGreaterThan(-1);
  expect(fork).toBeGreaterThan(dismiss);
});
