// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from "vitest";
import { SessionStore } from "../src/store.js";

it("marks a pending model choice as needing attention, not an agent running", () => {
  const store = new SessionStore();
  store.persistPendingSession("launch", "Saved prompt");
  store.setLaunchModelChoice("launch", { models: [], loading: true });
  expect(store.getState().sessionIndex.sessions[0]?.needsAction).toBe(false);
  store.setLaunchModelChoice("launch", { models: [] });
  expect(store.getState().sessionIndex.sessions[0]?.needsAction).toBe(true);
  store.setLaunchModelChoice("launch", { models: [], selecting: true });
  expect(store.getState().sessionIndex.sessions[0]?.needsAction).toBe(false);
  store.setLaunchModelChoice("launch", { models: [], error: "Selection timed out" });
  expect(store.getState().sessionIndex.sessions[0]?.needsAction).toBe(true);
  store.setLaunchModelChoice("launch", undefined);
  expect(store.getState().sessionIndex.sessions[0]?.needsAction).toBe(false);
  expect(store.getState().sessionIndex.sessions[0]?.launchProgress?.modelChoice).toBeUndefined();
});
