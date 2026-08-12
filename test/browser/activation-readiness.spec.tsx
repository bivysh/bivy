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

test("setup readiness never interrupts the normal session surface", async () => {
  const app = await read("../../packages/web/src/App.tsx");
  expect(app).not.toContain("<ReadinessChecklist");
  expect(app).not.toContain("activationFromState(state)");
  expect(app).not.toContain('authenticate_credential: () => openSettings("models")');
});

test("the readiness UI uses only canonical customer vocabulary", async () => {
  const view = await read("../../packages/web/src/components/ReadinessChecklist.tsx");
  for (const term of ["work item", "Work Queue", "routing label", ">Node<", ">Nodes<", "Runner", "ephemeral config", "lease"]) {
    expect(view.includes(term), `prohibited copy in ReadinessChecklist: ${term}`).toBe(false);
  }
});
