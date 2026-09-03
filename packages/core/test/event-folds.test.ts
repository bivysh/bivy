// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  foldCatalogSettingsEvent,
  foldConnectionEvent,
  foldPresentationEvent,
  foldSessionIndexEvent,
  initialState,
} from "../src/index.js";

describe("pure app event folds", () => {
  it("keeps AppState exclusively nested with no compatibility fields", () => {
    expect(Object.keys(initialState()).sort()).toEqual([
      "activeSession", "catalogs", "connection", "draft", "presentation", "sessionIndex", "settings",
    ]);
  });

  it("folds connection updates without mutating the input", () => {
    const value = { nodes: [{ id: "n1", name: "Before" }], currentNodeId: "n1", nodeUpdate: null, nodeUpdating: false };
    const result = foldConnectionEvent(value, { type: "node.updated", name: "After" });
    expect(result.handled).toBe(true);
    expect(result.value.nodes[0]?.name).toBe("After");
    expect(value.nodes[0]?.name).toBe("Before");
  });

  it("re-enables the update action after the updater acknowledges startup", () => {
    const value = { nodes: [], currentNodeId: null, nodeUpdate: { current: "0.1.0", latest: "0.2.0" }, nodeUpdating: true };
    const result = foldConnectionEvent(value, { type: "node.update.result", ok: true });
    expect(result.value.nodeUpdating).toBe(false);
    expect(result.value.nodeUpdate).toEqual(value.nodeUpdate);
  });

  it("composes independent index and presentation projections", () => {
    const index = { pausedSessionIds: [] as string[] };
    const paused = foldSessionIndexEvent(index, { type: "session.paused", sessionId: "s1" });
    expect(paused.value.pausedSessionIds).toEqual(["s1"]);
    expect(index.pausedSessionIds).toEqual([]);

    const presentation = { githubApp: null, prRefreshAllResult: null };
    const refreshed = foldPresentationEvent(presentation, { type: "sessions.pr_refresh_result", scanned: 3, changed: 1 });
    expect(refreshed.value.prRefreshAllResult).toEqual({ scanned: 3, changed: 1, error: undefined });
  });

  it("returns explicit catalog/settings patches", () => {
    expect(foldCatalogSettingsEvent({ type: "branches.list", repo: "bivysh/bivy", branches: [{ name: "main" }] })).toMatchObject({
      handled: true,
      catalogs: { branchesRepo: "bivysh/bivy", branchesLoading: false },
    });
    expect(foldCatalogSettingsEvent({ type: "node.settings", settings: { name: "Runner" } })).toEqual({
      handled: true,
      settings: { nodeSettings: { name: "Runner" } },
    });
  });
});
