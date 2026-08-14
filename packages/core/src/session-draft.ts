// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// New-session target selection as immutable data. Repository, branch, sandbox,
// reduced-protection acknowledgement, and ephemeral target share one lifetime:
// they are created and reset together, independently of live-session state.

import type { EphemeralNodeConfig } from "./account.js";

export type SandboxTier = "read-only" | "workspace-write" | "danger-full-access";

export interface SessionDraft {
  repo: string | null;
  branch: string | null;
  sandbox: SandboxTier | null;
  acknowledgeReducedProtections: boolean;
  ephemeralConfig: EphemeralNodeConfig | null;
}

export const EMPTY_SESSION_DRAFT: Readonly<SessionDraft> = Object.freeze({
  repo: null,
  branch: null,
  sandbox: null,
  acknowledgeReducedProtections: false,
  ephemeralConfig: null,
});

export type SessionDraftCommand =
  | { type: "select-repository"; repo: string | null }
  | { type: "select-branch"; branch: string | null }
  | { type: "select-sandbox"; sandbox: SandboxTier | null }
  | { type: "acknowledge-reduced-protections"; acknowledged: boolean }
  | { type: "select-ephemeral-config"; config: EphemeralNodeConfig | null }
  | { type: "reset" };

export function reduceSessionDraft(draft: Readonly<SessionDraft>, command: SessionDraftCommand): SessionDraft {
  switch (command.type) {
    case "select-repository":
      return draft.repo === command.repo
        ? { ...draft }
        : { ...draft, repo: command.repo, branch: null };
    case "select-branch":
      return { ...draft, branch: command.branch };
    case "select-sandbox":
      return { ...draft, sandbox: command.sandbox };
    case "acknowledge-reduced-protections":
      return { ...draft, acknowledgeReducedProtections: command.acknowledged };
    case "select-ephemeral-config":
      return { ...draft, ephemeralConfig: command.config };
    case "reset":
      return { ...EMPTY_SESSION_DRAFT };
  }
}
