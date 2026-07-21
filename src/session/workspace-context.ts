// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
export interface WorkspaceContext {
  /** User-selected workspace/root. For worktree sessions this may differ from cwd. */
  workspace: string;
  /** Directory where the runtime and Bivy-owned terminal should execute. */
  cwd: string;
  /** Isolated git worktree path when the session uses branch isolation. */
  worktree?: string;
  /** Current git branch for repo/worktree-backed sessions. */
  branch?: string;
  /** Safe repo slug when known, e.g. owner/repo. */
  repoSlug?: string;
}
