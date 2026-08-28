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
  const [view, preflight] = await Promise.all([
    read("../../packages/web/src/components/AutomationsView.tsx"),
    read("../../packages/web/src/components/AutomationPreflight.tsx"),
  ]);
  expect(view).toContain("useAutomationPreflight");
  expect(view).toContain("AutomationPreflightPanel");
  expect(preflight).toContain("export function useAutomationPreflight(");
  expect(preflight).toContain("export function AutomationPreflightPanel(");
  expect(preflight).toContain("Rule evaluation (first match wins)");
  expect(preflight).toContain("I understand the warnings above and want to save anyway.");
  expect(view).toContain('{preflight.busy ? "Checking…" : (d.trigger === "github" || d.trigger === "linear") ? "Test event" : "Check readiness"}');
  expect(view).toContain('{preflight.busy ? "Checking…" : "Check readiness"}');
});

test("a representative event is auto-derived from whichever trigger is configured, first enabled wins", async () => {
  const view = await read("../../packages/web/src/components/AutomationsView.tsx");
  expect(view).toContain("function buildRepresentativeEvent(d: Draft): AutomationSimulationEvent | undefined {");
  expect(view).toContain('if (d.githubEvents.issuesLabeled) return { kind: "github", repo, appId, event: "issues", action: "labeled"');
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

test("source-triggered GitHub and Linear runs carry encrypted automation instructions when configured", async () => {
  const [index, server, linear] = await Promise.all([
    read("../../services/control-plane/src/index.ts"),
    read("../../src/server.ts"),
    read("../../src/linear-tasks.ts"),
  ]);
  expect((index.match(/body: matched\.templateCiphertext/g) ?? []).length).toBeGreaterThanOrEqual(5);
  expect(server).toContain("instructions: item.body,");
  expect(server).toContain("buildTaskPrompt(issue, overrides.instructions ?? nodeGithubIssuePrompt())");
  expect(linear).toContain("export function buildLinearTaskPrompt(issue: LinearIssue, instructions?: string)");
  expect(server).toContain("buildLinearTaskPrompt(issue, item.body)");
});

test("account automation creation rejects unsupported trigger values instead of silently scheduling", async () => {
  const index = await read("../../services/control-plane/src/index.ts");
  expect(index).toContain('return res.status(400).json({ error: "unsupported automation trigger" });');
  expect(index).toContain('const trigger = rawTrigger as NonNullable<AutomationDefinition["trigger"]>;');
  expect(index).toContain('configOrder: nextConfigOrder,');
  expect(index).toContain('configOrder: req.body?.configOrder !== undefined ? requestedConfigOrder : current.configOrder,');
});

test("choosing a GitHub trigger does not auto-title a scratch automation", async () => {
  const view = await read("../../packages/web/src/components/AutomationsView.tsx");
  expect(view).toContain('name: current.name.trim() ? current.name : opts?.keepExistingName ? existing.name : ""');
  expect(view).toContain('{ keepExistingName: true }');
});

test("source automation priority is visible and reorderable because first match wins", async () => {
  const [view, match] = await Promise.all([
    read("../../packages/web/src/components/AutomationsView.tsx"),
    read("../../services/control-plane/src/automation-match.ts"),
  ]);
  expect(view).toContain("function automationPrioritySort(");
  expect(view).toContain("Priority: first match wins");
  expect(view).toContain("Move earlier");
  expect(view).toContain("Move later");
  expect(view).toContain("GitHub App source");
  expect(view).toContain("Hosted Bivy App");
  expect(match).toContain("UI-managed and");
  expect(match).toContain("config-as-code rows both use configOrder when present");
});
