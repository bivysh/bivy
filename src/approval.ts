// SPDX-License-Identifier: FSL-1.1-ALv2
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

export class ApprovalManager {
  private pending = new Map<string, Pending>();
  private history: ApprovalRequest[] = [];
  private listeners = new Set<(request: ApprovalRequest) => void>();

  onRequest(listener: (request: ApprovalRequest) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list() {
    return [...this.history, ...[...this.pending.values()].map((p) => p.request)];
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
        this.history.push(pending.request);
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
    this.history.push(pending.request);
    pending.resolve(approved);
    return true;
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
