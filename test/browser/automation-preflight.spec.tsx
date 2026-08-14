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

test("simulateAutomation and its result types are exported for the PWA to consume", async () => {
  const account = await read("../../packages/core/src/account.ts");
  expect(account).toContain("export function simulateAutomation(");
  expect(account).toContain('"/account/automations/simulate"');
  expect(account).toContain("export interface AutomationSimulationResult");
  expect(account).toContain("subjectId: string;");
  expect(account).toContain("export interface AutomationPreflightGate");
  expect(account).toContain("allowDangerous?: boolean;");
});

test("the automation editor runs the shared evaluator before every save, not just on demand", async () => {
  const view = await read("../../packages/web/src/components/AutomationsView.tsx");
  // Both editors call preflight.run right before their real create/update
  // request, and bail out on a block or an un-acknowledged warning instead
  // of ever reaching the API.
  expect(view).toContain("const evaluation = await preflight.run(input, undefined, { resetAck: false });");
  expect(view).toContain("if (evaluation.gate.blocked) {");
  expect(view).toContain("if (evaluation.gate.requiresAck && !preflight.ack) {");
  expect(view).toContain('const evaluation = await preflight.run({ ...patch, trigger, templateCiphertext: item.templateCiphertext }, undefined, { resetAck: false });');
});

test("Test event / Check readiness renders match trail, overlaps, and the preflight checklist", async () => {
  const view = await read("../../packages/web/src/components/AutomationsView.tsx");
  expect(view).toContain("function useAutomationPreflight(");
  expect(view).toContain("function AutomationPreflightPanel(");
  expect(view).toContain("Rule evaluation (first match wins)");
  expect(view).toContain("I understand the warnings above and want to save anyway.");
  expect(view).toContain('{preflight.busy ? "Checking…" : (d.trigger === "github" || d.trigger === "linear") ? "Test event" : "Check readiness"}');
  expect(view).toContain('{preflight.busy ? "Checking…" : "Check readiness"}');
});

test("a representative event is auto-derived from whichever trigger is configured, first enabled wins", async () => {
  const view = await read("../../packages/web/src/components/AutomationsView.tsx");
  expect(view).toContain("function buildRepresentativeEvent(d: Draft): AutomationSimulationEvent | undefined {");
  expect(view).toContain('if (d.githubEvents.issuesLabeled) return { kind: "github", repo, event: "issues", action: "labeled"');
  expect(view).toContain('if (d.trigger === "linear") return { kind: "linear", repo, labels: labels.length ? labels : ["bivy"] };');
});

test("the autonomous + full-access acknowledgement checkbox only appears for that exact combo, and feeds allowDangerous", async () => {
  const view = await read("../../packages/web/src/components/AutomationsView.tsx");
  expect(view).toContain('const unsafeCombo = d.approvalMode === "autonomous" && d.sandbox === "danger-full-access";');
  expect(view).toContain("{unsafeCombo && (");
  expect(view).toContain("I understand the risk of autonomous approval with full access — allow it anyway.");
  expect(view).toContain("const [allowDangerous, setAllowDangerous] = useState(false);");
});

test("legacy github_ci automations are exempt from requiring encrypted instructions server-side", async () => {
  // Regression coverage for the bug this PR's own preflight gate would
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
