// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

// A model-catalog failure must fail loud and partial, never silent and total.
// Silence here strands a Cloud launch: the client's models.list query can only
// time out ("Couldn't load models from this machine") with no cause named, and
// the composer picker shows "No models available." with no way to tell why.
test("a models.list catalog failure answers with the real error instead of silence", async () => {
  const server = await readFile(new URL("../../src/server.ts", import.meta.url), "utf8");
  // The handler must not let modelsListEventFor's rejection fall through to the
  // generic relay catch (which only console.warns) — it answers the requesting
  // session with the underlying reason.
  expect(server).toMatch(/event = await modelsListEventFor\(record\);[\s\S]{0,600}Couldn't read this machine's model catalog/);
  expect(server).toContain('sessionId: requestedSessionId ?? record.id');
});
