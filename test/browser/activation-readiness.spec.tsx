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

test("each readiness failure routes to a real remediation surface (no inert buttons)", async () => {
  const app = await read("../../packages/web/src/App.tsx");
  // The strip only shows before a real agent answer, in hosted mode with a Machine.
  expect(app).toContain("!activation.activated && !readinessDismissed");
  // Every remediation kind is wired to an existing surface.
  for (const kind of ["connect_machine", "install_agent", "authenticate_credential", "grant_repository", "run_starter_task"]) {
    expect(app).toContain(`${kind}:`);
  }
});

test("the readiness UI uses only canonical customer vocabulary", async () => {
  const view = await read("../../packages/web/src/components/ReadinessChecklist.tsx");
  for (const term of ["work item", "Work Queue", "routing label", ">Node<", ">Nodes<", "Runner", "ephemeral config", "lease"]) {
    expect(view.includes(term), `prohibited copy in ReadinessChecklist: ${term}`).toBe(false);
  }
});
