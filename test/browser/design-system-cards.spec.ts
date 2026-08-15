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

test("blocking interaction cards use the canonical card shell", async () => {
  for (const [path, className] of [
    ["components/ApprovalCard.tsx", "card approval-card"],
    ["components/QuestionCard.tsx", "card question-card"],
    ["components/TurnAttentionCard.tsx", "card question-card turn-attention-card"],
  ]) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    expect(source, path).toContain(className);
  }
});

test("interaction-specific card CSS only owns layout", async () => {
  const css = await readFile(new URL("styles.css", ROOT), "utf8");
  expect(ruleFor(css, ".card")).toContain("background: var(--surface)");
  expect(css).toContain('.card[data-tone="danger"]');
  expect(ruleFor(css, ".question-card")).not.toMatch(/(?:background|border(?!-collapse)|border-radius|padding)\s*:/);
  expect(css).not.toContain(".approval-card {");
});
