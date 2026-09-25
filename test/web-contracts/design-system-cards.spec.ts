// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../packages/web/src/", import.meta.url);

test("new approval and question cards announce themselves and receive focus", async () => {
  const [app, approval, question, attention] = await Promise.all([
    readFile(new URL("App.tsx", ROOT), "utf8"),
    readFile(new URL("components/ApprovalCard.tsx", ROOT), "utf8"),
    readFile(new URL("components/QuestionCard.tsx", ROOT), "utf8"),
    readFile(new URL("components/TurnAttentionCard.tsx", ROOT), "utf8"),
  ]);
  expect(app).toContain('aria-live="polite"');
  expect(app).toContain('querySelector<HTMLElement>("[data-attention-card]")?.focus()');
  for (const source of [approval, question, attention]) {
    expect(source).toContain("data-attention-card");
    expect(source).toContain("tabIndex={-1}");
    expect(source).toContain("data-tone=");
  }
});
