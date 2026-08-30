// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("activation is never ready before a real agent response (model invariant)", async () => {
  const model = await read("../../packages/core/src/activation.ts");
  // Readiness is derived from the final agent-answered check, not the chain.
  expect(model).toContain('const activated = checks[checks.length - 1]?.state === "passed";');
  // agentAnswered is set ONLY by a real assistant message with text.
  expect(model).toContain('state.transcript.some((e) => e.role === "assistant" && Boolean(e.text) && !e.tool) ? true : undefined');
});

test("the readiness strip renders nothing once activated and never claims premature success", async () => {
  const view = await read("../../packages/web/src/components/ReadinessChecklist.tsx");
  // Hard gate: activated → render nothing.
  expect(view).toContain("if (activation.activated) return null;");
  // No inert buttons: the next action renders only when a handler exists.
  expect(view).toContain("next && handler &&");
  // It renders the distinct checks with their states.
  expect(view).toContain("activation.checks.map((check)");
});

test("setup readiness is wired only into a first-ever draft and remediation stays in flow", async () => {
  const app = await read("../../packages/web/src/App.tsx");
  expect(app).toContain("!state.activeSession.activeSessionId && state.activeSession.transcript.length === 0 && state.sessionIndex.sessions.length === 0");
  expect(app).toContain("<ReadinessChecklist");
  expect(app).toContain("deriveActivation({");
  expect(app).toContain("state.catalogs.activationReadiness ? state.catalogs.activationReadiness.credential.ok : undefined");
  expect(app).toContain('connect_machine: () => (document.querySelector(".node-switcher-btn")');
  expect(app).toContain('authenticate_credential: () => (document.querySelector(".model-pill")');
  expect(app).not.toContain('authenticate_credential: () => openSettings(');
});

test("the readiness UI uses only canonical customer vocabulary", async () => {
  const view = await read("../../packages/web/src/components/ReadinessChecklist.tsx");
  for (const term of ["work item", "Work Queue", "routing label", ">Node<", ">Nodes<", "Runner", "ephemeral config", "lease"]) {
    expect(view.includes(term), `prohibited copy in ReadinessChecklist: ${term}`).toBe(false);
  }
});
