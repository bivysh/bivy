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
    ["components/ChangesCard.tsx", "card changes-card"],
    ["components/FollowupQueue.tsx", "card followup-card"],
    ["components/SetupNotice.tsx", "card setup-card"],
    ["components/TuiLockedView.tsx", "card tui-locked-card"],
    ["components/ReadinessChecklist.tsx", "card readiness"],
    ["components/WorkQueueSetupSheet.tsx", "card wq-status-card"],
    ["components/Rulesets.tsx", "card ruleset-rule-card"],
    ["components/GithubQueue.tsx", "card queue-card"],
    ["components/AutomationsView.tsx", "card autom-runner-card"],
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
  for (const selector of [".tui-locked-card", ".followup-card", ".wq-status-card", ".setup-card", ".changes-card", ".readiness", ".ruleset-rule-card", ".queue-card", ".autom-runner-card"]) {
    expect(ruleFor(css, selector), selector).not.toMatch(/(?:background|border(?!-collapse)|border-radius|box-shadow)\s*:/);
  }
});
