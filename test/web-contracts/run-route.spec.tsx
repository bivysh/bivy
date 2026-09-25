// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("the new Run UI carries no prohibited customer vocabulary", async () => {
  const detail = await read("../../packages/web/src/components/RunDetails.tsx");
  const prohibited = ["work item", "Work item", "Work Queue", "routing label", "outcome report", "Outcome report", "ephemeral config", "lease", "claim ", "Enrolled node", ">Node<", ">Nodes<"];
  for (const term of prohibited) {
    expect(detail.includes(term), `prohibited customer copy in RunDetails: ${term}`).toBe(false);
  }
});
