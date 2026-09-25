// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Security and safety invariants of the PWA that no behavior test covers yet.
// They read source text, which is brittle, so each one should be replaced by a
// behavior test of the component or controller it names, then deleted here.
// Everything else that used to live in test/web-contracts was copy, class-name
// or wiring text and has been removed; design-system rules live in
// scripts/check-design-tokens.mjs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../packages/web/src/", import.meta.url);
const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");
const expect = (value: string, label?: string) => ({
  toContain: (text: string) => assert.ok(value.includes(text), `${label ?? "source"} should contain ${JSON.stringify(text)}`),
  toMatch: (pattern: RegExp) => assert.match(value, pattern, label),
  not: { toContain: (text: string) => assert.ok(!value.includes(text), `${label ?? "source"} should not contain ${JSON.stringify(text)}`) },
});

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

test("Stop gives immediate progress and a recovery timeout", async () => {
  const composer = await readFile(new URL("../packages/web/src/components/Composer.tsx", import.meta.url), "utf8");
  expect(composer).toContain("setStopping(true)");
  expect(composer).toContain("Stopping…");
  expect(composer).toContain("10_000");
  expect(composer).toContain("The agent didn&apos;t confirm it stopped.");
});

test("browser-node convergence preserves an offline key rotation", async () => {
  const controller = await read("../packages/web/src/store/coordinators/credentials-models-coordinator.ts");
  expect(controller).toContain("acceptedIncoming");
  expect(controller).toContain("remoteAt > localAt");
  expect(controller).toContain("deletedAt[recordId]");
  expect(controller).toContain("record.kind !== \"api_key\"");
  expect(controller).not.toContain('if (this.direct || this.store.getState().status !== "online")');
});

test("a Run targeting an existing Session resumes or fails visibly and never cold-starts without context", async () => {
  const server = await read("../src/server.ts");
  expect(server).toContain('resumeOnMissing: item.source === "schedule" || item.targetKind === "existing_session"');
  expect(server).toContain("the session is not available on this Machine");
  expect(server).toContain("await waitForSessionIdle(record)");
  expect(server).toContain("if (record.worktree && !opts?.isMessage)");
});

// A model-catalog failure must fail loud and partial, never silent and total.
// Silence here strands a Cloud launch: the client's models.list query can only
// time out ("Couldn't load models from this machine") with no cause named, and
// the composer picker shows "No models available." with no way to tell why.
test("a models.list catalog failure answers with the real error instead of silence", async () => {
  const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  // The handler must not let modelsListEventFor's rejection fall through to the
  // generic relay catch (which only console.warns) — it answers the requesting
  // session with the underlying reason.
  expect(server).toMatch(/event = await modelsListEventFor\(record\);[\s\S]{0,600}Couldn't read this machine's model catalog/);
  expect(server).toContain('sessionId: requestedSessionId ?? record.id');
});

test("Add a machine mints a one-time account enrollment command", async () => {
  const sheet = await read("../packages/web/src/components/AddNodeSheet.tsx");
  const controlPlane = await read("../services/control-plane/src/index.ts");
  const instructions = await read("../packages/web/src/components/MachineInstallInstructions.tsx");
  expect(sheet).toContain("<MachineInstallInstructions />");
  expect(instructions).toContain("controller.createNodeClaim()");
  expect(instructions).toContain("Single-use · expires in 10 minutes");
  expect(instructions).not.toContain("controller.local.s");
  expect(sheet).not.toContain('href="/install.sh"');
  expect(controlPlane).toContain("BIVY_NODE_CLAIM_CODE=${shellSingleQuote(code)}");
  expect(controlPlane).toContain("BIVY_CONTROL_PLANE_URL=${shellSingleQuote(baseUrl(req))}");
  expect(controlPlane).toContain("BIVY_NODE_CLAIM_CODE");
});

test("source Automation templates enter the encrypted review flow before going live", async () => {
  const view = await read("../packages/web/src/components/AutomationsView.tsx");
  const templateFlow = view.slice(view.indexOf('function startFromSourceTemplate('), view.indexOf('function startFromTemplate('));
  expect(templateFlow).toContain('setDraft({');
  expect(templateFlow).toContain('instructions: defaultSourceInstructions()');
  expect(templateFlow).toContain('template.trigger === "github_ci"');
  expect(templateFlow).not.toContain('createAutomation(');
  expect(templateFlow).not.toContain('updateAutomation(');
  expect(view).toContain("Draft · needs GitHub");
});

test("full computer access requires an informed second action", async () => {
  const source = await readFile(new URL("../packages/web/src/components/Pickers.tsx", import.meta.url), "utf8");
  expect(source).toContain('t.id === "danger-full-access"');
  expect(source).toContain("Confirm full computer access");
  expect(source).toContain("Bivy is not an isolation boundary");
});

test("opening the queue panel cannot trigger billable provisioning", async () => {
  const source = await readFile(new URL("../packages/web/src/components/GithubQueue.tsx", import.meta.url), "utf8");
  expect(source).not.toContain("launchEphemeralQueueWorker(");
  expect(source).toContain("maybeAutoProvision policy owns launch/dedupe/rate-cap/teardown");
});

test("interactive billable runners disclose cost and teardown before selection", async () => {
  const source = await readFile(new URL("../packages/web/src/components/Ephemeral.tsx", import.meta.url), "utf8");
  expect(source).toContain('title="Use this billable machine profile?"');
  expect(source).toContain("ephemeralCostHint");
  expect(source).toContain("controller.pickDraftEphemeralRunner(pendingRunner)");
});

test("failed ephemeral machines are retained only by explicit debug build opt-in", async () => {
  const source = await readFile(new URL("../packages/web/src/flags.ts", import.meta.url), "utf8");
  expect(source).toContain('VITE_BIVY_KEEP_FAILED_EPHEMERAL === "1"');
  expect(source).not.toContain("EPHEMERAL_KEEP_FAILED_MACHINES = true");
});
