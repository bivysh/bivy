// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("Automations keeps run history scoped to each automation", async () => {
  const [view, history] = await Promise.all([
    read("../../packages/web/src/components/AutomationsView.tsx"),
    read("../../packages/web/src/components/RunHistory.tsx"),
  ]);
  expect(view).toContain('{ label: "Automations", section: null }');
  expect(view).toContain("automation-history-btn");
  expect(view).toContain("automation-row-run-status");
  expect(view).toContain("<RunHistory");
  expect(history).toContain('className="autom-section runs-overview"');
  expect(history).toContain("Live status and recent outcomes.");
  expect(history).toContain('className="run-row-chevron"');
  expect(history).toContain("onClick={() => onOpenRun(run.id)}");
  expect(view).toContain("automation-history-view");
  expect(view).toContain("showHistory={false}");
  // Creation remains reachable while reviewing Runs or policy.
  expect(view).not.toContain("{section === null && (\n            <button type=\"button\" className=\"btn autom-new-btn\"");
});

test("the automation editor makes runner and encryption readiness explicit", async () => {
  const view = await read("../../packages/web/src/components/AutomationsView.tsx");
  expect(view).toContain('className="autom-field-block autom-runner-block"');
  expect(view).toContain('aria-label="Run on machine"');
  expect(view).toContain("key missing on this device");
  expect(view).toContain("account sign-in alone cannot decrypt them");
  expect(view).toContain("Cloud and model sign-ins are separate");
});

test("mobile Automations uses full-height editors and reachable touch targets", async () => {
  const css = await read("../../packages/web/src/styles.css");
  expect(css).toContain("@media (max-width: 479px)");
  expect(css).toContain("height: 100dvh");
  expect(css).toContain(".wizard-actions .btn { min-height: 44px; }");
  expect(css).toContain("flex: 1 0 auto; min-height: 44px; padding: 10px 14px;");
  expect(css).toContain(".automation-row .row-menu-btn { min-width: 40px; min-height: 40px; opacity: 1; }");
  expect(css).toContain(".runs-overview .autom-section-head { align-items: stretch; flex-direction: column; }");
  expect(css).toContain(".runs-overview .autom-section-actions { display: grid; grid-template-columns: 1fr 1fr; width: 100%; }");
});

test("ephemeral-only routing reports credential readiness instead of failing later", async () => {
  const routing = await read("../../packages/web/src/components/QueueRouting.tsx");
  expect(routing).toContain("Ready for unattended runs");
  expect(routing).toContain("Setup needs attention");
  expect(routing).toContain("hosted.validatedProviders.includes(config.provider)");
  expect(routing).toContain('hosted.credential !== "none"');
  expect(routing).toContain("GitHub/model sign-ins available to the fresh runner");
});

test("connecting an existing GitHub App waits for and reports the machine result", async () => {
  const [sheet, controller] = await Promise.all([
    read("../../packages/web/src/components/WorkQueueSetupSheet.tsx"),
    read("../../packages/web/src/store/controller.ts"),
  ]);
  expect(sheet).toContain("await controller.githubAppConnectExisting");
  expect(sheet).toContain("App connected.</strong> This machine now holds the key");
  expect(sheet).toContain('role="alert">{ceHostedError}');
  expect(controller).toContain("await this.awaitAck({");
  expect(controller).toContain('kind: "github.app.connect-existing"');
});
