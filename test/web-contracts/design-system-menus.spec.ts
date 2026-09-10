// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../packages/web/src/", import.meta.url);
const STYLES = new URL("styles.css", ROOT);

const POPOVERS = [
  ["components/SessionMenu.tsx", 'className="menu session-actions-menu"'],
  ["components/AutomationsView.tsx", 'className="menu row-menu-pop"'],
  ["components/SessionList.tsx", 'className="menu session-filter-menu"'],
  ["components/Pickers.tsx", 'className="menu reasoning-menu"'],
  ["components/Terminal.tsx", 'className="menu term-attach-menu"'],
  ["components/NodeSwitcher.tsx", 'className="menu node-menu"'],
  ["components/Composer.tsx", 'className="menu slash-menu"'],
] as const;

function ruleFor(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`rule not found: ${selector}`);
  const declarations = css.indexOf("{", start) + 1;
  return css.slice(declarations, css.indexOf("}", declarations));
}

test("floating popovers use the canonical menu shell", async () => {
  for (const [path, className] of POPOVERS) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    expect(source, path).toContain(className);
  }
});

test("surface-specific popover CSS only owns placement and layout", async () => {
  const css = await readFile(STYLES, "utf8");
  const canonical = ruleFor(css, ".menu");
  expect(canonical).toContain("background: var(--surface)");
  expect(canonical).toContain("box-shadow: var(--shadow-lg)");

  for (const selector of [
    ".session-actions-menu",
    ".row-menu-pop",
    ".session-filter-menu",
    ".reasoning-menu",
    ".term-attach-menu",
    ".node-menu",
    ".slash-menu",
  ]) {
    const local = ruleFor(css, selector);
    expect(local, `${selector} must inherit its visual shell from .menu`).not.toMatch(
      /(?:background|border|border-radius|box-shadow|animation)\s*:/,
    );
  }
});
