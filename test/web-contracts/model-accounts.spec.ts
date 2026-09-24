// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "@playwright/test";
import { modelAccountChoice } from "../../packages/web/src/modelAccounts.js";

// Pure account routing needs neither a Vite server nor a browser/viewport.
test("account routing follows project, active, default and ambiguity rules", () => {
  const records = [{ label: "default" }, { label: "work" }];
  const config = { active: "personal", presets: { personal: { anthropic: "default" }, default: { anthropic: "work" }, "project:acme/app": { anthropic: "work" } } };
  expect(modelAccountChoice("anthropic", records, config, "acme/app")).toEqual({ preset: "project:acme/app", label: "work" });
  expect(modelAccountChoice("anthropic", records, config)).toEqual({ preset: "personal", label: "default" });
  expect(modelAccountChoice("anthropic", records, config, "/repos/acme__app/.bivy/worktrees/session")).toEqual({ preset: "project:/repos/acme__app/.bivy/worktrees/session", label: "work" });
  expect(modelAccountChoice("anthropic", records, { presets: { default: { anthropic: "work" } } }).label).toBe("work");
  expect(modelAccountChoice("anthropic", records, {}).label).toBe("default");
  expect(modelAccountChoice("anthropic", [{ label: "work" }], {}).label).toBe("work");
  expect(modelAccountChoice("anthropic", [{ label: "home" }, { label: "work" }], {}).label).toBeUndefined();
  expect(modelAccountChoice("anthropic", records, { active: "bad", presets: { bad: { anthropic: "missing" } } }).label).toBeUndefined();
  expect(modelAccountChoice("anthropic", records, null).label).toBeUndefined();
});
