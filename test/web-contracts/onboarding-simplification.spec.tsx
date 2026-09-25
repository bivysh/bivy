// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

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

test("source Automation templates enter the encrypted review flow before going live", async () => {
  const view = await read("../../packages/web/src/components/AutomationsView.tsx");
  const templateFlow = view.slice(view.indexOf('function startFromSourceTemplate('), view.indexOf('function startFromTemplate('));
  expect(templateFlow).toContain('setDraft({');
  expect(templateFlow).toContain('instructions: defaultSourceInstructions()');
  expect(templateFlow).toContain('template.trigger === "github_ci"');
  expect(templateFlow).not.toContain('createAutomation(');
  expect(templateFlow).not.toContain('updateAutomation(');
  expect(view).toContain("Draft · needs GitHub");
});

test("first-use custody language matches the product trust boundary", async () => {
  const connect = await read("../../packages/web/src/components/ConnectRunner.tsx");
  const model = await read("../../packages/web/src/components/FirstRunModelAuth.tsx");
  expect(connect).not.toContain("Bivy never receives your code or keys");
  expect(connect).toContain("hosted credential custody");
  expect(model).toContain("hosted credential custody");
});
