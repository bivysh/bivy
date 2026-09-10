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

test("the first isolated Run offers a safe task and names the billable launch action", async () => {
  const composer = await read("../../packages/web/src/components/Composer.tsx");
  expect(composer).toContain("Start with a safe read-only task");
  expect(composer).toContain("Inspect this repository and explain how to run its tests. Do not change files.");
  expect(composer).toContain("Launch Machine and send task");
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
