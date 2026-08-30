// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("the draft exposes one actionable first-session review", async () => {
  const [composer, chat, decisions] = await Promise.all([
    readFile(new URL("../../packages/web/src/components/Composer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../packages/web/src/components/ChatView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../packages/web/src/firstSession.ts", import.meta.url), "utf8"),
  ]);
  expect(chat).toContain("Describe your task");
  expect(chat).not.toContain("Choose the <b>machine</b> to run on in the header");
  expect(composer).toContain('aria-label="Review before starting"');
  expect(composer).toContain("decisions.map((decision)");
  expect(composer).toContain("openDecision(decision.key)");
  expect(decisions).toContain('"Choose a model"');
  expect(decisions).not.toContain('const DASH = "—"');
});

test("agent picker uses one readiness badge and plain-language confirmation", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/Pickers.tsx", import.meta.url), "utf8");
  expect(source).toContain('className="picker-section-label">Recommended');
  expect(source).toContain('className="picker-section-toggle"');
  expect(source).toContain("More agents");
  expect(source).toContain('readiness={installing ? "Setting up" : available ? "Ready" : installable ? "Install" : "Needs sign-in"}');
  expect(source).toContain("Bivy couldn't check which sign-in this agent will use");
  expect(source).toContain("Use {agentLabel(confirmingRuntime)}");
  expect(source).not.toContain("title={confirming ? `Confirm ${agentLabel(a)}`");
});

test("full computer access requires an informed second action", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/Pickers.tsx", import.meta.url), "utf8");
  expect(source).toContain('t.id === "danger-full-access"');
  expect(source).toContain("Confirm full computer access");
  expect(source).toContain("Bivy is not an isolation boundary");
});

test("settings use task-oriented groups and search panel concepts", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/Settings.tsx", import.meta.url), "utf8");
  for (const group of ["Models & keys", "Machines", "App", "Account"]) {
    expect(source).toContain(`label: "${group}"`);
  }
  // Integrations (GitHub/Linear/Slack) and automation & policy (Runs,
  // Rulesets) moved to the Automations hub — Settings no longer lists
  // them, it only redirects stale /settings/:view deep links there.
  expect(source).not.toContain('label: "Integrations"');
  expect(source).not.toContain('label: "Automation & policy"');
  expect(source).toContain("onRedirectToAutomations");
  expect(source).toContain("SEARCH_TERMS[item.id]");
});

test("automations is the single hub for connections, history and rulesets", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/AutomationsView.tsx", import.meta.url), "utf8");
  expect(source).toContain('label: "Automations"');
  expect(source).toContain('label: "Runs", section: "runs"');
  expect(source).toContain('label: "Rulesets"');
  expect(source).toContain('className="automations-tabs segmented"');
  expect(source).not.toContain('className={`automations-tab');
  expect(source).toContain("automation-history-btn");
  // The standalone Webhooks tab was removed — a webhook is just an automation
  // whose trigger is "webhook" (configured in Triggers), and its signed
  // endpoint + secret now live inline on the automation's Overview row.
  expect(source).not.toContain('label: "Webhooks"');
  expect(source).not.toContain("WebhooksPanel");
  // Source connections and the panels reused from Settings all live here now.
  expect(source).toContain("GithubQueuePanel");
  expect(source).toContain("RulesetsPanel");
});

test("legacy queue URLs redirect to the Runs destination", async () => {
  const source = await readFile(new URL("../../packages/web/src/router.ts", import.meta.url), "utf8");
  expect(source).toContain('if (v === "queue") return "runs";');
  expect(source).toContain('readonly AutomationsSection[] = ["runs", "rulesets"]');
});

test("GitHub trigger creation stays in one complete automation editor", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/AutomationsView.tsx", import.meta.url), "utf8");
  expect(source).toContain("onSelectSource(opt.source, d)");
  expect(source).toContain('items.find((item) => item.trigger === source)');
  expect(source).toContain('missing.push("a GitHub event")');
  expect(source).toContain('templateCiphertext: `${TEMPLATE_PREFIX}:${d.nodeId}:${encrypted}`');
  expect(source).toContain('on: buildGithubOn(d.githubEvents, labels, workflows)');
});

test("model auth failures render as an actionable card without stack frames", async () => {
  const [chat, composer, fold] = await Promise.all([
    readFile(new URL("../../packages/web/src/components/ChatView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../packages/web/src/components/Composer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../packages/core/src/active-session-event-fold.ts", import.meta.url), "utf8"),
  ]);
  expect(chat).toContain('className="card" data-tone="danger"');
  expect(chat).toContain('return "Connect a provider"');
  expect(chat).toContain('entry.text.split("\\n")');
  expect(fold).toContain('structured?.kind === "model_auth"');
  expect(composer).toContain('setPicker("model")');
  expect(composer).toContain('modelId === "unknown"');
  const app = await readFile(new URL("../../packages/web/src/App.tsx", import.meta.url), "utf8");
  expect(app).toContain("!state.sessionIndex.sessions.some((session) => session.bivyCreated)");
});

test("provider key save awaits an authoritative acknowledgement", async () => {
  const source = await readFile(new URL("../../packages/web/src/components/ProviderConnect.tsx", import.meta.url), "utf8");
  expect(source).toContain("await controller.setCredential");
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
  expect(source).toContain('title="Use this billable machine profile?"');
  expect(source).toContain("ephemeralCostHint");
  expect(source).toContain("controller.pickDraftEphemeralRunner(pendingRunner)");
});

test("failed ephemeral machines are retained only by explicit debug build opt-in", async () => {
  const source = await readFile(new URL("../../packages/web/src/flags.ts", import.meta.url), "utf8");
  expect(source).toContain('VITE_BIVY_KEEP_FAILED_EPHEMERAL === "1"');
  expect(source).not.toContain("EPHEMERAL_KEEP_FAILED_MACHINES = true");
});
