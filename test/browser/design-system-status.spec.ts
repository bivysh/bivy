// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ROOT = new URL("../../packages/web/src/", import.meta.url);

test("machine presence uses the canonical StatusDot", async () => {
  for (const path of ["components/NodeSwitcher.tsx", "components/ConnectRunner.tsx"]) {
    const source = await readFile(new URL(path, ROOT), "utf8");
    expect(source, path).toContain("<StatusDot");
    expect(source, path).not.toContain("node-dot");
  }
});

test("canonical status dots expose every documented state", async () => {
  const css = await readFile(new URL("styles.css", ROOT), "utf8");
  expect(css).toContain(".status-dot {");
  for (const status of ["unseen", "online", "working", "needs-action", "failed", "saved"]) {
    expect(css).toContain(`.status-dot[data-status="${status}"]`);
  }
  expect(css).not.toContain(".node-dot");
});
