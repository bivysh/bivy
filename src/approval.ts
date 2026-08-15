// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { randomUUID } from "node:crypto";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  reason: string;
  risk?: string;
  /** Session workspace, so a resolved decision can be remembered for "this repo". */
  workspace?: string;
  repo?: string;
  branch?: string;
  createdAt: number;
  status: ApprovalStatus;
}

type Pending = {
  request: ApprovalRequest;
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
};

/** Cap on retained resolved/expired approvals so a long-lived daemon can't grow
 * history (and every /api/approvals + session-list scan) without bound. */
const MAX_HISTORY = 200;

export class ApprovalManager {
  private pending = new Map<string, Pending>();
  private history: ApprovalRequest[] = [];
  private listeners = new Set<(request: ApprovalRequest) => void>();

  /** Append to history, trimming to the most recent MAX_HISTORY entries. */
  private record(request: ApprovalRequest) {
    this.history.push(request);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
  }

  onRequest(listener: (request: ApprovalRequest) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list() {
    return [...this.history, ...[...this.pending.values()].map((p) => p.request)];
  }

  /** Unanswered approvals for a session. Carried into a fork bundle so a move
   *  DISCLOSES them (they belong to the source runtime's turn and can't replay
   *  across a fork) rather than silently dropping the pending decision. */
  pendingFor(sessionId: string): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request).filter((r) => r.sessionId === sessionId);
  }

  async request(input: {
    sessionId: string;
    toolName: string;
    toolInput: unknown;
    reason: string;
    risk?: string;
    workspace?: string;
    repo?: string;
    branch?: string;
    timeoutMs?: number;
  }): Promise<boolean> {
    const request: ApprovalRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      toolName: input.toolName,
      input: input.toolInput,
      reason: input.reason,
      risk: input.risk,
      workspace: input.workspace,
      repo: input.repo,
      branch: input.branch,
      createdAt: Date.now(),
      status: "pending",
    };

    const approved = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(request.id);
        if (!pending) return;
        pending.request.status = "expired";
        this.pending.delete(request.id);
        this.record(pending.request);
        resolve(false);
      }, input.timeoutMs ?? 5 * 60_000);

      this.pending.set(request.id, { request, resolve, timeout });
      for (const listener of this.listeners) listener(request);
    });

    return approved;
  }

  resolve(id: string, approved: boolean) {
    const pending = this.pending.get(id);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    pending.request.status = approved ? "approved" : "rejected";
    this.pending.delete(id);
    this.record(pending.request);
    pending.resolve(approved);
    return true;
  }

  /** Cancel (deny) any pending approvals for a session being torn down, so a
   * killed/closed session's ApprovalCard doesn't linger on connected clients
   * until its 5-minute timeout. Mirrors QuestionManager.cancelForSession. */
  cancelForSession(sessionId: string) {
    for (const [id, pending] of this.pending) {
      if (pending.request.sessionId === sessionId) this.resolve(id, false);
    }
  }

  resolveAll(approved: boolean) {
    const ids = [...this.pending.keys()];
    const resolved: ApprovalRequest[] = [];
    for (const id of ids) {
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.resolve(id, approved);
      resolved.push(pending.request);
    }
    return resolved;
  }
}
