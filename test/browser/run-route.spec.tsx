// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("the router serializes and restores /runs/:runId through @bivy/core helpers", async () => {
  const router = await read("../../packages/web/src/router.ts");
  // Route union, parse, and serialize are all wired, and id parsing is delegated
  // to the single tested core helper so the route is identical across clients.
  expect(router).toContain('{ kind: "run"; id: string }');
  expect(router).toContain("parseRunRoute(pathname)");
  expect(router).toContain("runRoutePath(route.id)");
  expect(router).toContain('import { parseRunRoute, runRoutePath } from "@bivy/core"');
});

test("a Run detail is an overlay that never resets the active Session", async () => {
  const controller = await read("../../packages/web/src/store/controller.ts");
  const runRoute = await read("../../packages/web/src/runRoute.ts");
  // applyRoute ignores `run` (like settings/automations) so a deep link / reload
  // onto /runs/:runId keeps the session behind it intact.
  expect(controller).toContain('route.kind !== "run"');
  // The overlay store restores from the URL on cold load and on Back/Forward.
  expect(runRoute).toContain("fromRoute(parseRoute())");
  expect(runRoute).toContain('window.addEventListener("popstate"');
});

test("the control plane serves the shell and a non-leaking single-Run API", async () => {
  const cp = await read("../../services/control-plane/src/index.ts");
  // The shell fallback covers /runs alongside /sessions (one handler, one sink).
  expect(cp).toContain("/^\\/(?:sessions|runs)\\/.+/");
  expect(cp).toContain('app.get("/account/automation-runs/:id"');
  // Unknown and cross-account ids are indistinguishable (a non-leaking 404).
  expect(cp).toContain('return res.status(404).json({ error: "Automation run not found" })');
});

test("the Run details screen handles every explicit state and never overclaims a Receipt", async () => {
  const detail = await read("../../packages/web/src/components/RunDetails.tsx");
  // Loading, offline, not-found, unauthorized, and ready are all distinct states.
  for (const state of ['status === "loading"', 'status === "offline"', 'status === "not_found"', 'status === "unauthorized"', 'status === "ready"']) {
    expect(detail).toContain(state);
  }
  // Mutations refresh the durable record rather than inventing terminal state.
  expect(detail).toContain("await refresh({ keepPrevious: true })");
  // The canonical Run projection backs the screen — not a second projection.
  expect(detail).toContain("runFromAutomationRun(record");
  // Receipt v1 is not correlated yet: the screen shows it as unavailable and
  // must never call this a Receipt.
  expect(detail).toContain(">Receipt<");
  expect(detail).toContain("Unavailable — a Receipt for this Run isn");
});

test("Open Session appears only when the correlated Session is resolvable", async () => {
  const detail = await read("../../packages/web/src/components/RunDetails.tsx");
  expect(detail).toContain("isSessionResolvable(run.sessionId!)");
  expect(detail).toContain(">Open Session<");
});

test("the new Run UI carries no prohibited customer vocabulary", async () => {
  const detail = await read("../../packages/web/src/components/RunDetails.tsx");
  const prohibited = ["work item", "Work item", "Work Queue", "routing label", "outcome report", "Outcome report", "ephemeral config", "lease", "claim ", "Enrolled node", ">Node<", ">Nodes<"];
  for (const term of prohibited) {
    expect(detail.includes(term), `prohibited customer copy in RunDetails: ${term}`).toBe(false);
  }
});

test("every Run surface links to the exact Run route, preserving the Run id", async () => {
  const [app, automations, queue, pill] = await Promise.all([
    read("../../packages/web/src/App.tsx"),
    read("../../packages/web/src/components/AutomationsView.tsx"),
    read("../../packages/web/src/components/GithubQueue.tsx"),
    read("../../packages/web/src/components/RunPill.tsx"),
  ]);
  // Automation activity, queue/history, and the in-session Run pill all deep-link
  // by the exact Run id; App maps each onto /runs/:runId.
  expect(automations).toContain("onClick={() => onOpenRun(run.id)}");
  expect(queue).toContain("onClick={() => onOpenRun(item.id)}");
  // Session → Run: the pill opens the correlated Run by its stable id (a retry
  // keeps the same Run id).
  expect(pill).toContain("onClick={() => { setOpen(false); onOpenRun(evidence.id); }}");
  expect(app).toContain("openRun(runId)");
  expect(app).toContain("load={(id) => fetchAutomationRun(controller.local, id)}");
});
