// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("turn completion and session index reconcile the composer working state", async () => {
  const [server, store] = await Promise.all([
    readFile(new URL("../../src/server.ts", import.meta.url), "utf8"),
    readFile(new URL("../../packages/core/src/store.ts", import.meta.url), "utf8"),
  ]);
  expect(server).toMatch(/event\.type === "turn_end"[\s\S]*clearSessionWorking\(record\)/);
  expect(server).toMatch(/event\.type === "turn_end"[\s\S]*finishHarnessTurn\(record\)/);
  expect(store).toContain('activeRow.status !== "working"');
  expect(store).toContain('working: false, workingLabel: ""');
});

test("Stop gives immediate progress and a recovery timeout", async () => {
  const composer = await readFile(new URL("../../packages/web/src/components/Composer.tsx", import.meta.url), "utf8");
  expect(composer).toContain("setStopping(true)");
  expect(composer).toContain("Stopping…");
  expect(composer).toContain("10_000");
  expect(composer).toContain("The agent didn&apos;t confirm it stopped.");
});

test("the run pill receives the single human-facing status word", async () => {
  const [app, status] = await Promise.all([
    readFile(new URL("../../packages/web/src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../packages/web/src/sessionStatus.ts", import.meta.url), "utf8"),
  ]);
  expect(app).toContain("statusLabel={runStatusLabel(activeSession)}");
  for (const label of ["Working", "Waiting for you", "Finished"]) expect(status).toContain(`return "${label}"`);
});
