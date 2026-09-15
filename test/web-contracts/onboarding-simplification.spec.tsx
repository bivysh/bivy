// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("isolated first use recommends one cloud and hides the rest behind progressive disclosure", async () => {
  const view = await read("../../packages/web/src/components/Ephemeral.tsx");
  expect(view).toContain('p.id === "fly"');
  expect(view).toContain("Other cloud providers");
  expect(view).toContain("<Badge>Available</Badge>");
});

test("only local first tasks offer a no-edit prompt; cloud launch remains explicitly named", async () => {
  const composer = await read("../../packages/web/src/components/Composer.tsx");
  expect(composer).toContain("Start with a small task");
  expect(composer).toContain("const firstTask = isDraft && !firstIsolatedRun");
  expect(composer).toContain("{firstTask && !text.trim()");
  const app = await read("../../packages/web/src/App.tsx");
  expect(app).toContain("!needsNode && !state.draft.ephemeralConfig && !state.activeSession.activeSessionId");
  expect(composer).toContain("Inspect this repository and explain how to run its tests. Do not change files.");
  expect(composer).toContain("Launch Machine and send task");
});

test("a managed repository picker offers the central App to established accounts", async () => {
  const pickers = await read("../../packages/web/src/components/Pickers.tsx");
  expect(pickers).toContain("Install Bivy GitHub App");
  expect(pickers).toContain("Use Bivy GitHub App");
  expect(pickers).toContain("Use my GitHub App");
  expect(pickers).toContain("Use this App on hosted Machines");
  expect(pickers).toContain("separate from any custom GitHub App connected to a personal Machine");
  expect(pickers).toContain("managedDraft && state.catalogs.reposAuthed && <AddHostedGithubInstallation />");
  expect(pickers).toContain("Add another GitHub account or organization…");
});

test("Bivy Cloud is a first-class unattended automation target", async () => {
  const editor = await read("../../packages/web/src/components/AutomationsView.tsx");
  const provisioner = await read("../../services/control-plane/src/ephemeral-provisioner.ts");
  expect(editor).toContain("Bivy Cloud · managed");
  expect(editor).toContain("managedAutomationTarget");
  // The persisted key takes precedence after a lost provider response. The
  // executable control-plane escrow tests verify identity across retries.
  expect(provisioner).toContain("const reuseRoomKeyB64 = persistedKey ? decryptSecret(accountId, persistedKey) : retry?.roomKeyB64");
  expect(provisioner).toContain("hasManagedAutomation");
});

test("new accounts flow from GitHub into a Bivy Cloud draft with provider setup in that session", async () => {
  const onboarding = await read("../../packages/web/src/components/FirstRunOnboarding.tsx");
  expect(onboarding).toContain("If provider setup is needed, it happens inside that same session.");
  expect(onboarding).toContain("Sign in with a model provider");
  expect(onboarding).toContain("controller.ensureManagedSessionDefaults()");
  expect(onboarding).toContain("controller.pickDraftEphemeralRunner(config)");
  expect(onboarding).not.toContain('readiness-label">Machine');
});

test("Add a machine mints a one-time account enrollment command", async () => {
  const sheet = await read("../../packages/web/src/components/AddNodeSheet.tsx");
  const controlPlane = await read("../../services/control-plane/src/index.ts");
  const instructions = await read("../../packages/web/src/components/MachineInstallInstructions.tsx");
  expect(sheet).toContain("<MachineInstallInstructions />");
  expect(instructions).toContain("controller.createNodeClaim()");
  expect(instructions).toContain("Single-use · expires in 10 minutes");
  expect(instructions).not.toContain("controller.local.s");
  expect(sheet).not.toContain('href="/install.sh"');
  expect(controlPlane).toContain("BIVY_NODE_CLAIM_CODE=${shellSingleQuote(code)}");
  expect(controlPlane).toContain("BIVY_CONTROL_PLANE_URL=${shellSingleQuote(baseUrl(req))}");
  expect(controlPlane).toContain("BIVY_NODE_CLAIM_CODE");
});

test("voice input remains available after the user types a message", async () => {
  const composer = await read("../../packages/web/src/components/Composer.tsx");
  const mic = composer.indexOf('className="composer-btn mic"');
  expect(mic).toBeGreaterThan(-1);
  expect(composer.slice(mic - 250, mic)).not.toContain("!canSend &&");
});

test("source Automation templates enter the encrypted review flow before going live", async () => {
  const view = await read("../../packages/web/src/components/AutomationsView.tsx");
  expect(view).toContain('if (template.trigger !== "github_ci")');
  expect(view).toContain("Review the encrypted instructions and turn it on when ready.");
  expect(view).toContain("Finish connecting the source, then review and turn on the Automation.");
  expect(view).toContain("Draft · needs GitHub");
});

test("first-use custody language matches the product trust boundary", async () => {
  const connect = await read("../../packages/web/src/components/ConnectRunner.tsx");
  const model = await read("../../packages/web/src/components/FirstRunModelAuth.tsx");
  expect(connect).not.toContain("Bivy never receives your code or keys");
  expect(connect).toContain("hosted credential custody");
  expect(model).toContain("hosted credential custody");
});
