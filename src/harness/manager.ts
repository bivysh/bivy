// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Universal Agent Harness — per-session checkpoint lifecycle.
//
// Thin, runtime-agnostic coordinator the daemon calls around a turn, regardless
// of which agent runtime backs the session. It owns one CheckpointStore per live
// session and turns the raw git primitives into the three events the product
// needs: a snapshot before a turn, the structured diff a turn produced, and a
// rewind. If a session's workspace is not a git repo, the harness disables itself
// for that session (every method becomes a safe no-op) so non-repo sessions keep
// working exactly as before.
//
// Deliberately holds no transport/UI types: the daemon maps TurnChanges onto its
// own `session.changes` broadcast and the `session.rewind` command. Unit-tested
// in test/harness-manager.test.ts.

import { CheckpointStore, NotAGitRepoError, type Checkpoint, type FileChange } from "./checkpoint.js";

export interface TurnChanges {
  /** Checkpoint taken before the turn started (undefined for the very first turn). */
  before?: Checkpoint;
  /** Checkpoint taken after the turn ended. */
  after: Checkpoint;
  /** Structured per-file diff the turn produced (before → after). */
  changes: FileChange[];
}

export class HarnessManager {
  private readonly stores = new Map<string, CheckpointStore>();
  /** Checkpoint captured at the start of the currently-running turn, per session. */
  private readonly turnBase = new Map<string, Checkpoint | undefined>();

  /**
   * Begin tracking a session's workspace. Returns true when checkpointing is
   * available (the workspace is inside a git repo), false otherwise — the caller
   * can surface a "rewind unavailable" hint but must not treat false as an error.
   */
  async attach(sessionId: string, worktree: string): Promise<boolean> {
    if (this.stores.has(sessionId)) return true;
    try {
      const store = await CheckpointStore.open(worktree, sessionId);
      this.stores.set(sessionId, store);
      return true;
    } catch (error) {
      if (error instanceof NotAGitRepoError) return false;
      throw error;
    }
  }

  detach(sessionId: string): void {
    this.stores.delete(sessionId);
    this.turnBase.delete(sessionId);
  }

  isTracking(sessionId: string): boolean {
    return this.stores.has(sessionId);
  }

  /**
   * Snapshot the workspace at the start of a turn. Safe no-op for untracked
   * (non-repo) sessions. Idempotent within a turn: a second call before endTurn
   * keeps the original base so a mid-turn re-prompt doesn't lose the diff origin.
   */
  async beginTurn(sessionId: string, label: string): Promise<void> {
    const store = this.stores.get(sessionId);
    if (!store) return;
    if (this.turnBase.has(sessionId)) return;
    this.turnBase.set(sessionId, await store.snapshot(label));
  }

  /**
   * Snapshot the workspace at the end of a turn and return the structured diff
   * against the turn's base. Returns undefined for untracked sessions or when
   * beginTurn was never called. Returns an empty `changes` array when the turn
   * touched no files.
   */
  async endTurn(sessionId: string, label: string): Promise<TurnChanges | undefined> {
    const store = this.stores.get(sessionId);
    if (!store) return undefined;
    if (!this.turnBase.has(sessionId)) return undefined;
    const before = this.turnBase.get(sessionId);
    this.turnBase.delete(sessionId);
    const after = await store.snapshot(label);
    const changes = before ? await store.changesBetween(before, after) : [];
    return { before, after, changes };
  }

  /** The full checkpoint chain for a session, newest first. */
  async checkpoints(sessionId: string): Promise<Checkpoint[]> {
    const store = this.stores.get(sessionId);
    if (!store) return [];
    return await store.list();
  }

  /**
   * Restore a session's workspace to a checkpoint. Throws if the session isn't
   * tracked or the id is unknown to git. Any in-flight turn base is cleared so
   * the next turn re-snapshots from the restored state.
   */
  async rewind(sessionId: string, checkpointId: string): Promise<void> {
    const store = this.stores.get(sessionId);
    if (!store) throw new Error(`Session ${sessionId} is not tracked by the harness.`);
    await store.rewindTo(checkpointId);
    this.turnBase.delete(sessionId);
  }
}
