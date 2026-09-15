// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createPendingEphemeralLaunchStore, indexedDbBackend, type PendingEphemeralLaunch } from "../src/ephemeral-storage.js";

it("persists a launch with a live transport without cloning its functions or private state", async () => {
  const store = createPendingEphemeralLaunchStore(indexedDbBackend(new IDBFactory(), "launch-test", "launches", "id"));
  const now = new Date().toISOString();
  const launch: PendingEphemeralLaunch = {
    id: "launch", config: { id: "cloud", name: "Cloud", provider: "fly", createdAt: now, updatedAt: now },
    prompt: { text: "Test", requestId: "request", clientMessageId: "message", frame: { kind: "session.new", requestId: "request" } },
    followups: [], logs: [], phase: "booting", createdAt: now, updatedAt: now,
  };
  await store.put({ ...launch, transport: { send: () => {}, privateValue: "not-persisted" }, promptSent: true } as PendingEphemeralLaunch);
  const [saved] = await store.list();
  expect(saved).toMatchObject(launch);
  expect(saved).not.toHaveProperty("transport");
  expect(saved).not.toHaveProperty("promptSent");
});
