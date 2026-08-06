// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { RuntimeCapabilities } from "../runtime/types.js";
import type { SandboxTier } from "../harness/sandbox.js";
import type { WorkspaceContext } from "./workspace-context.js";

export type BivySessionSource = "manual" | "github_issue" | "api" | `repo:${string}` | string;

export type BivySessionStatus = "idle" | "working" | "needs_attention" | "done" | "failed";

/**
 * Runtime-neutral Bivy session envelope. Runtime-specific identifiers stay opaque
 * in runtimeSessionRef; callers should route by this Bivy id and runtimeId.
 */
export interface BivySessionRecord {
  id: string;
  nodeId?: string;
  runtimeId: string;
  runtimeSessionRef?: string;

  workspace: string;
  worktree?: string;
  branch?: string;
  workspaceContext?: WorkspaceContext;

  titleEncrypted?: string;
  titleLocal?: string;
  source: BivySessionSource;
  status: BivySessionStatus;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;

  capabilities: RuntimeCapabilities;

  /**
   * Per-session sandbox tier this session was created with (the escape-hatch
   * override), if one was chosen. Absent = the session runs at the node default.
   * Baked in at creation and read-only for the life of the session.
   */
  sandbox?: SandboxTier;

  /** GitHub context for issue-driven or repo sessions (for pills + links) */
  repoSlug?: string;
  issueNumber?: number;
  issueUrl?: string;
  prUrl?: string;
  githubIssueUrl?: string;
}
