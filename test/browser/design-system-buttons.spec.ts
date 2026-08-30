// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../packages/web/src/", import.meta.url);
const STYLES = new URL("styles.css", ROOT);

function ruleFor(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`rule not found: ${selector}`);
  const declarations = css.indexOf("{", start) + 1;
  return css.slice(declarations, css.indexOf("}", declarations));
}

test("canonical button shell exposes the documented variants", async () => {
  const css = await readFile(STYLES, "utf8");
  expect(ruleFor(css, ".btn")).toContain("border-radius: var(--radius-sm)");
  for (const selector of [
    ".btn.primary",
    ".btn.danger",
    ".btn.ghost",
    ".btn.danger-ghost",
    ".btn.link",
    ".btn.icon",
    ".btn.sm",
    ".btn.lg",
  ]) expect(css).toContain(`${selector} {`);
});

test("migrated call-to-actions inherit the canonical button shell", async () => {
  const surfaces = [
    ["App.tsx", 'className="btn sm primary banner-action"'],
    ["components/ChatView.tsx", 'className="btn sm primary"'],
    ["components/ForkSheet.tsx", 'className="btn primary fork-submit"'],
    ["components/ImportSessionSheet.tsx", 'className="btn sm primary import-session-action"'],
    ["components/AutomationsView.tsx", 'className="btn primary" onClick={openChooser}'],
  ] as const;
  for (const [path, className] of surfaces) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    expect(source, path).toContain(className);
  }

  const css = await readFile(STYLES, "utf8");
  for (const selector of [".fork-submit", ".import-session-action", ".banner-action"]) {
    expect(ruleFor(css, selector), `${selector} should only own layout`).not.toMatch(
      /(?:background|border(?!-collapse)|border-radius|color|font-size|font-weight|padding)\s*:/,
    );
  }
  expect(css).not.toContain(".notice-action");
});

test("legacy link, ghost, and icon buttons have been removed", async () => {
  const paths = [
    "components/Pickers.tsx",
    "components/Rulesets.tsx",
    "components/ProviderConnect.tsx",
    "components/SetupNotice.tsx",
    "components/WorkQueueSetupSheet.tsx",
    "components/CredentialVault.tsx",
    "components/Settings.tsx",
    "components/RunDetails.tsx",
    "components/GithubQueue.tsx",
    "components/Terminal.tsx",
    "components/AutomationsView.tsx",
    "App.tsx",
  ];
  for (const path of paths) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    expect(source, path).not.toMatch(/(?:link|ghost|icon)-btn/);
  }
  const css = await readFile(STYLES, "utf8");
  expect(css).not.toMatch(/\.(?:link|ghost|icon)-btn/);
});
