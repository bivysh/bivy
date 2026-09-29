// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { SessionRecord } from "./record.js";

/**
 * The creation fields of an existing session, for "start another like it"
 * (`session.new` with `like`): same project, agent, model and safety. A git
 * worktree session points back at its checkout, so the new session gets its own
 * worktree off the default branch instead of sharing this one's; a plain folder
 * is shared, as any new session in it would be.
 */
export function sessionLikeFields(source: Pick<SessionRecord, "workspace" | "worktree" | "runtimeId" | "sandbox"> & {
  session: { getCurrentModel(): { provider?: unknown; id?: unknown } | undefined | null };
}): Record<string, unknown> {
  const model = source.session.getCurrentModel();
  return {
    workspace: source.worktree?.repoRoot ?? source.workspace,
    agent: source.runtimeId,
    ...(source.sandbox ? { sandbox: source.sandbox } : {}),
    ...(model?.id ? { model: { provider: String(model.provider ?? ""), id: String(model.id) } } : {}),
  };
}
