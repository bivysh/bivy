// SPDX-License-Identifier: AGPL-3.0-only
//
// The PWA half of the shared automation evaluator (see
// docs/automation-evaluator.md): the Automations editors' "Test event" /
// "Check readiness" workflow and the save-time preflight gate. Mirrors the
// source-assertion style already used for this surface in
// automations-mobile-ux.spec.tsx rather than mounting the component.
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("legacy github_ci automations are exempt from requiring encrypted instructions server-side", async () => {
  // Regression coverage for a bug the preflight gate itself would
  // otherwise have introduced: github_ci runs on DEFAULT_FIX_CI_PROMPT
  // (dispatchAutomationDefinition) when no ciphertext is set, so requiring
  // one would have blocked saving/editing every seeded CI automation.
  const [match, index] = await Promise.all([
    read("../../services/control-plane/src/automation-match.ts"),
    read("../../services/control-plane/src/index.ts"),
  ]);
  expect(match).toContain('required: def.trigger !== "github_ci",');
  expect(index).toContain("body: matched.templateCiphertext || DEFAULT_FIX_CI_PROMPT");
});

test("account automation creation rejects unsupported trigger values instead of silently scheduling", async () => {
  const index = await read("../../services/control-plane/src/index.ts");
  expect(index).toContain('return res.status(400).json({ error: "unsupported automation trigger" });');
  expect(index).toContain('const trigger = rawTrigger as NonNullable<AutomationDefinition["trigger"]>;');
  expect(index).toContain('configOrder: nextConfigOrder,');
  expect(index).toContain('configOrder: req.body?.configOrder !== undefined ? requestedConfigOrder : current.configOrder,');
});
