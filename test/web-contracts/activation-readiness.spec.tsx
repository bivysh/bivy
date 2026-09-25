// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("the readiness UI uses only canonical customer vocabulary", async () => {
  const view = await read("../../packages/web/src/components/ReadinessChecklist.tsx");
  for (const term of ["work item", "Work Queue", "routing label", ">Node<", ">Nodes<", "Runner", "ephemeral config", "lease"]) {
    expect(view.includes(term), `prohibited copy in ReadinessChecklist: ${term}`).toBe(false);
  }
});
