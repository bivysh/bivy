// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import { EMPTY_SESSION_DRAFT, reduceSessionDraft } from "../src/session-draft.js";

describe("session draft value reducer", () => {
  it("clears a branch when repository identity changes", () => {
    const selected = reduceSessionDraft(EMPTY_SESSION_DRAFT, { type: "select-repository", repo: "bivysh/bivy" });
    const branched = reduceSessionDraft(selected, { type: "select-branch", branch: "feature" });
    const changed = reduceSessionDraft(branched, { type: "select-repository", repo: "other/repo" });
    expect(changed).toMatchObject({ repo: "other/repo", branch: null });
    expect(branched).toMatchObject({ repo: "bivysh/bivy", branch: "feature" });
  });

  it("reduces serializable commands without mutating prior values", () => {
    const commands = [
      { type: "select-sandbox" as const, sandbox: "read-only" as const },
      { type: "acknowledge-reduced-protections" as const, acknowledged: true },
    ];
    const draft = commands.reduce(reduceSessionDraft, { ...EMPTY_SESSION_DRAFT });
    expect(draft).toMatchObject({ sandbox: "read-only", acknowledgeReducedProtections: true });
    expect(EMPTY_SESSION_DRAFT).toMatchObject({ sandbox: null, acknowledgeReducedProtections: false });
  });

  it("resets all target choices as one value", () => {
    const configured = {
      ...EMPTY_SESSION_DRAFT,
      repo: "bivysh/bivy",
      branch: "main",
      sandbox: "workspace-write" as const,
      acknowledgeReducedProtections: true,
    };
    expect(reduceSessionDraft(configured, { type: "reset" })).toEqual(EMPTY_SESSION_DRAFT);
  });
});
