// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("agent picker separates recommended agents and exposes protection", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/Pickers.tsx", import.meta.url), "utf8");
  expect(source).toContain('className="picker-section-label">Recommended');
  expect(source).toContain('className="picker-section-toggle"');
  expect(source).toContain("More agents");
  expect(source).toContain("runtime.protectionLevel");
  expect(source).toContain("Runs with your OS user permissions and no Bivy-owned isolation");
});

test("full computer access requires an informed second action", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/Pickers.tsx", import.meta.url), "utf8");
  expect(source).toContain('t.id === "danger-full-access"');
  expect(source).toContain("Confirm full computer access");
  expect(source).toContain("Bivy is not an isolation boundary");
});

test("settings use task-oriented groups and search panel concepts", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/Settings.tsx", import.meta.url), "utf8");
  for (const group of ["Models & agents", "Machines", "App", "Account"]) {
    expect(source).toContain(`label: "${group}"`);
  }
  // Integrations (GitHub/Linear/Slack) and automation & policy (Work Queue,
  // Rulesets) moved to the Automations hub — Settings no longer lists
  // them, it only redirects stale /settings/:view deep links there.
  expect(source).not.toContain('label: "Integrations"');
  expect(source).not.toContain('label: "Automation & policy"');
  expect(source).toContain("onRedirectToAutomations");
  expect(source).toContain("SEARCH_TERMS[item.id]");
});

test("automations is the single hub for connections, work queue and rulesets", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/AutomationsView.tsx", import.meta.url), "utf8");
  for (const tab of ["Overview", "Work Queue", "Rulesets"]) {
    expect(source).toContain(`label: "${tab}"`);
  }
  // The standalone Webhooks tab was removed — a webhook is just an automation
  // whose trigger is "webhook" (configured in Triggers), and its signed
  // endpoint + secret now live inline on the automation's Overview row.
  expect(source).not.toContain('label: "Webhooks"');
  expect(source).not.toContain("WebhooksPanel");
  // Source connections and the panels reused from Settings all live here now.
  expect(source).toContain("GithubQueuePanel");
  expect(source).toContain("RulesetsPanel");
});

test("provider key save awaits an authoritative acknowledgement", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/ProviderConnect.tsx", import.meta.url), "utf8");
  expect(source).toContain("await controller.saveApiKey");
  expect(source).toContain('role="alert"');
  expect(source).not.toContain("setTimeout(() => {\n              controller.listProviders()");
});

test("global attention count reaches title and installed app badge", async () => {
  const source = await readFile(new URL("../../packages/web/src/App.tsx", import.meta.url), "utf8");
  expect(source).toContain('document.title = count > 0 ? `(${count}) Bivy` : "Bivy"');
  expect(source).toContain("setAppBadge?.(count)");
  expect(source).toContain("clearAppBadge?.()");
});

test("opening the queue panel cannot trigger billable provisioning", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/GithubQueue.tsx", import.meta.url), "utf8");
  expect(source).not.toContain("launchEphemeralQueueWorker(");
  expect(source).toContain("maybeAutoProvision policy owns launch/dedupe/rate-cap/teardown");
});

test("interactive billable runners disclose cost and teardown before selection", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/Ephemeral.tsx", import.meta.url), "utf8");
  expect(source).toContain('title="Use this billable runner?"');
  expect(source).toContain("ephemeralCostHint");
  expect(source).toContain("controller.pickDraftEphemeralRunner(pendingRunner)");
});

test("failed ephemeral machines are retained only by explicit debug build opt-in", async () => {
  const source = await readFile(new URL("../../packages/web/src/flags.ts", import.meta.url), "utf8");
  expect(source).toContain('VITE_BIVY_KEEP_FAILED_EPHEMERAL === "1"');
  expect(source).not.toContain("EPHEMERAL_KEEP_FAILED_MACHINES = true");
});
