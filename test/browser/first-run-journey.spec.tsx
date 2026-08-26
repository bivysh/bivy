// SPDX-License-Identifier: AGPL-3.0-only
//
// The critical readiness-led first-run journey: sign-in -> machine pair/select
// -> provider connection -> supported-agent verification -> first successful
// assistant response. Each step already has its own dedicated, well-tested
// screen (SetupNotice, ConnectRunner, ReadinessChecklist) — this file verifies
// they're wired together in the right order/conditions in App.tsx, that every
// failure is actionable (a remediation with a real handler), and that nothing
// about the journey depends on client-only state that a reload would lose.
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("the journey gates in order: sign-in first, then cohesive onboarding, then the readiness strip", async () => {
  const app = await read("../../packages/web/src/App.tsx");
  const needsAuth = app.indexOf("if (needsAuth || signInRequested) {");
  const needsNodeDecl = app.indexOf("const needsNode =");
  const readinessStrip = app.indexOf("<ReadinessChecklist");
  expect(needsAuth).toBeGreaterThan(-1);
  expect(needsNodeDecl).toBeGreaterThan(-1);
  expect(readinessStrip).toBeGreaterThan(-1);
  // The sign-in gate returns early (a full-screen replace), so it's checked
  // and rendered before the readiness strip's own JSX is ever reached.
  expect(needsAuth).toBeLessThan(readinessStrip);
  // Only a *summoned* sign-in (a solo pairing asking for an account from
  // Automations / cloud machine profiles) is dismissable — the boot-time auth
  // gate has no app behind it to return to, so it never gets onDismiss.
  expect(app).toContain("<SetupNotice onDismiss={needsAuth ? undefined : dismissSignInRequest} />");
  // A fresh GitHub signup enters one authoritative wizard for App install,
  // Machine enrollment, and model auth. Dismissing it deliberately falls back
  // to the ordinary ConnectRunner; established users still get the readiness
  // strip rather than being forced through a second wizard.
  expect(app).toContain("{showFirstRunOnboarding && (");
  expect(app).toContain("<FirstRunOnboarding");
  expect(app).toContain("!showFirstRunOnboarding && needsNode");
  expect(app).toContain("<ConnectRunner");
});

test("direct/self-host mode never shows the sign-in gate — it has no account to sign into", async () => {
  const app = await read("../../packages/web/src/App.tsx");
  expect(app).toContain("const needsAuth = !controller.direct && !controller.solo && !state.connection.signedIn;");
});

test("every failed readiness check maps to exactly one wired, real remediation — no inert buttons", async () => {
  const app = await read("../../packages/web/src/App.tsx");
  const checklist = await read("../../packages/web/src/components/ReadinessChecklist.tsx");
  // ReadinessChecklist itself refuses to render a button without a handler.
  expect(checklist).toContain("next && handler &&");
  // App.tsx supplies a real handler for every remediation EXCEPT sign_in,
  // which is deliberately absent: by the time this strip can render, the
  // sign-in gate above has already guaranteed the user is signed in (or is in
  // direct mode, where the check is never `failed` at all) — a real handler
  // here would have nothing to do.
  for (const kind of ["connect_machine", "install_agent", "authenticate_credential", "grant_repository", "run_starter_task"]) {
    expect(app).toContain(`${kind}: () =>`);
  }
  expect(app).not.toContain("sign_in: () =>");
});

test("managed-only cold start performs provider setup on the original interactive Machine", async () => {
  const wizard = await read("../../packages/web/src/components/FirstRunOnboarding.tsx");
  const controller = await read("../../packages/web/src/store/controller.ts");
  const accountApi = await read("../../packages/core/src/account.ts");
  const controlPlane = await read("../../services/control-plane/src/index.ts");
  const provisioner = await read("../../services/control-plane/src/ephemeral-provisioner.ts");
  expect(wizard).not.toContain("controller.createManagedAuthRunner()");
  expect(controller).toContain("beginManagedCredentialSetup");
  expect(controller).toContain("tryRepublishManagedCredential");
  expect(controller).toContain("Stay on the original provisional session route");
  expect(provisioner).toContain("hostedCredentialPublisher");
  expect(controlPlane).toContain("managed guests cannot replace hosted credentials");
  expect(wizard).toContain("controller.ensureManagedSessionDefaults()");
  expect(accountApi).toContain("/account/managed-machines");
  expect(controlPlane).toContain('purpose: "interactive"');
});

test("provider readiness ('Test connection') is wired end to end: web action -> relay command -> node handler", async () => {
  const controller = await read("../../packages/web/src/store/coordinators/credentials-models-coordinator.ts");
  const vault = await read("../../packages/web/src/components/CredentialVault.tsx");
  // The node handler lives in the extracted credential command controller.
  const handler = await read("../../src/controllers/credential-commands.ts");
  expect(controller).toContain("async testCredential(provider: string, label: string)");
  expect(vault).toContain("controller.testCredential(selected.provider, selected.label)");
  const onboarding = await read("../../packages/web/src/components/FirstRunOnboarding.tsx");
  expect(onboarding).toContain("controller.testCredential(activeCredential.provider, activeCredential.label)");
  expect(onboarding).not.toMatch(/runtime\.id\.includes\(["'](?:codex|claude)["']\)/);
  expect(handler).toContain('async "credential.test"(msg, ctx) {');
});

test("managed first prompts render quiet provisioning milestones in the session", async () => {
  const controller = await read("../../packages/web/src/store/controller.ts");
  expect(controller).toContain("Reserving secure managed compute…");
  expect(controller).toContain('updateLaunchCheckpoint(provisionalId, "credentials", "active")');
  expect(controller).toContain("Repository and agent are ready. Sending your prompt…");
  expect(controller).toContain("beginManagedCredentialSetup");
});

test("managed runner images contain every supported selectable external agent and failed starts stay actionable", async () => {
  const dockerfile = await read("../../deploy/Dockerfile.ephemeral-runner");
  const controller = await read("../../packages/web/src/store/controller.ts");
  const progress = await read("../../packages/web/src/components/SessionLaunchProgress.tsx");
  expect(dockerfile).toContain("@openai/codex@0.147.0");
  expect(dockerfile).toContain("@anthropic-ai/claude-code@2.1.246");
  expect(dockerfile).toContain("command -v codex");
  expect(controller).toContain("retryPendingLaunchOnFreshMachine");
  expect(progress).toContain("Retry on a new Cloud Machine");
});

test("progress survives a reload because it's derived from authoritative signals, not a client-only wizard flag", async () => {
  const app = await read("../../packages/web/src/App.tsx");
  // The activation projection is computed fresh from live state every render
  // (status/runtimes/credential probes/transcript) — grep for the absence of
  // a bespoke "current step" localStorage key, which would be the smell of a
  // separate, reload-fragile progress tracker living alongside the real one.
  expect(app).not.toMatch(/localStorage\.[gs]etItem\(["']bivy\.(setup|onboarding|firstRun)Step/);
  expect(app).toContain("deriveActivation({");
  // The one genuinely new persisted fact — whether a credential has been
  // verified to work — is stored server-side on the node (see
  // BivyCredentialStore.writeVerification), not in browser storage, so it
  // survives a reload AND a reinstalled PWA.
  const store = await read("../../src/credentials/store.ts");
  expect(store).toContain("async writeVerification(");
});
