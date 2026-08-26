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

test("the first isolated Run keeps session controls visible without a canned starter task", async () => {
  const composer = await read("../../packages/web/src/components/Composer.tsx");
  expect(composer).not.toContain("Start with a safe read-only task");
  expect(composer).not.toContain("composer-advanced");
  expect(composer).toContain('className="pill sandbox-pill"');
  expect(composer).toContain('className="pill agent-pill"');
  expect(composer).toContain('className="pill model-pill"');
  expect(composer).toContain("Launch Machine and send task");
});

test("a managed repository picker offers the central App to established accounts", async () => {
  const pickers = await read("../../packages/web/src/components/Pickers.tsx");
  expect(pickers).toContain("Install Bivy GitHub App");
  expect(pickers).toContain("Use Bivy GitHub App");
  expect(pickers).toContain("Use my GitHub App");
  expect(pickers).toContain("Use this App on hosted Machines");
  expect(pickers).toContain("separate from any custom GitHub App connected to a personal Machine");
});

test("voice input remains available after the user types a message", async () => {
  const composer = await read("../../packages/web/src/components/Composer.tsx");
  const mic = composer.indexOf('className="composer-btn mic"');
  expect(mic).toBeGreaterThan(-1);
  expect(composer.slice(mic - 250, mic)).not.toContain("!canSend &&");
});

test("source Automations remain drafts until their source is connected", async () => {
  const view = await read("../../packages/web/src/components/AutomationsView.tsx");
  expect(view).toContain("enabled: sourceReady");
  expect(view).toContain("saved as a draft");
  expect(view).toContain("It cannot receive events yet.");
  expect(view).toContain("Draft · needs GitHub");
});

test("first-use custody language matches the product trust boundary", async () => {
  const connect = await read("../../packages/web/src/components/ConnectRunner.tsx");
  const model = await read("../../packages/web/src/components/FirstRunModelAuth.tsx");
  expect(connect).not.toContain("Bivy never receives your code or keys");
  expect(connect).toContain("hosted credential custody");
  expect(model).toContain("hosted credential custody");
});
