// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../packages/web/src/", import.meta.url);

function ruleFor(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`rule not found: ${selector}`);
  const declarations = css.indexOf("{", start) + 1;
  return css.slice(declarations, css.indexOf("}", declarations));
}

test("transient feedback uses the canonical Toast", async () => {
  for (const path of ["components/ErrorToast.tsx", "components/NoticeToast.tsx", "components/UpdatePrompt.tsx"]) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    expect(source, path).toContain("<Toast");
  }
  const errors = await readFile(new URL("components/ErrorToast.tsx", ROOT), "utf8");
  const notices = await readFile(new URL("components/NoticeToast.tsx", ROOT), "utf8");
  expect(errors).toContain('<StatusIcon tone="danger">');
  expect(notices).toContain('<StatusIcon tone="ok">');
});

test("toast-specific CSS only owns layout and behavior", async () => {
  const css = await readFile(new URL("styles.css", ROOT), "utf8");
  expect(ruleFor(css, ".toast")).toContain("box-shadow: var(--shadow-lg)");
  for (const selector of [".update-toast", ".error-toast", ".notice-toast"]) {
    expect(ruleFor(css, selector), selector).not.toMatch(/(?:background|border(?!-collapse)|border-radius|box-shadow|padding)\s*:/);
  }
  expect(css).not.toMatch(/\.(?:error|notice)-toast-icon/);
});
