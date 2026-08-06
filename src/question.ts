// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { randomUUID } from "node:crypto";
import type { UserQuestionAnswer, UserQuestionItem } from "./runtime/types.js";

// Bivy owns the AskUserQuestion → interactive-question-card feature at the
// governance layer, NOT inside any single runtime adapter. A `user_question`
// is a blocking, multiple-choice clarifying question an agent raises mid-turn
// (Claude Code's AskUserQuestion tool, and any future agent that emits the same
// tool). It is intercepted in the guardian tool-interceptor — the one seam every
// runtime with capabilities.toolInterception already implements — so pi and the
// Claude Agent SDK both light up with zero per-runtime question code. This is
// the deliberate sibling of ApprovalManager: same block-and-wait shape, but it
// returns the user's structured answers instead of a yes/no.

/** How long a pending question waits for an answer before auto-cancelling.
 *  Without this a client that never renders/answers the card (a stale client,
 *  a UI bug, nobody looking) would park the agent's tool call — and the turn —
 *  indefinitely. Mirrors the old runtime-side QUESTION_TIMEOUT_MS. */
const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;

export type QuestionStatus = "pending" | "answered" | "cancelled" | "expired";

export interface QuestionRequest {
  id: string;
  sessionId: string;
  questions: UserQuestionItem[];
  createdAt: number;
  status: QuestionStatus;
}

type Pending = {
  request: QuestionRequest;
  resolve: (answer: UserQuestionAnswer) => void;
  timeout: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
};

export class QuestionManager {
  private pending = new Map<string, Pending>();
  private requestListeners = new Set<(request: QuestionRequest) => void>();
  private resolvedListeners = new Set<(request: QuestionRequest) => void>();

  /** Notified when a new question is raised — the server broadcasts
   *  `session.question` from here (mirrors approvals.onRequest). */
  onRequest(listener: (request: QuestionRequest) => void) {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  /** Notified every time a question settles — answered, cancelled, timed out,
   *  or aborted — exactly once. The server broadcasts `session.question.resolved`
   *  from here, so it fires precisely when the card should close. */
  onResolved(listener: (request: QuestionRequest) => void) {
    this.resolvedListeners.add(listener);
    return () => this.resolvedListeners.delete(listener);
  }

  list(): QuestionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  hasPendingForSession(sessionId: string): boolean {
    for (const p of this.pending.values()) if (p.request.sessionId === sessionId) return true;
    return false;
  }

  /**
   * Raise a blocking question and resolve once the user answers/skips (or it
   * times out / the turn aborts). Called from the guardian interceptor; the
   * returned answer is formatted back to the agent as the tool result.
   */
  request(input: {
    sessionId: string;
    questions: UserQuestionItem[];
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<UserQuestionAnswer> {
    const request: QuestionRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      questions: input.questions,
      createdAt: Date.now(),
      status: "pending",
    };

    return new Promise<UserQuestionAnswer>((resolve) => {
      // Already-aborted turn: settle immediately, never register.
      if (input.signal?.aborted) {
        request.status = "cancelled";
        resolve({ behavior: "cancelled" });
        for (const l of this.resolvedListeners) l(request);
        return;
      }

      const timeout = setTimeout(() => this.settle(request.id, { behavior: "cancelled" }, "expired"), input.timeoutMs ?? QUESTION_TIMEOUT_MS);
      const onAbort = () => this.settle(request.id, { behavior: "cancelled" }, "cancelled");
      input.signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(request.id, { request, resolve, timeout, onAbort, signal: input.signal });
      for (const l of this.requestListeners) l(request);
    });
  }

  /** Deliver the user's answer (or a skip/cancel) to a pending question. A
   *  stale/unknown id is a silent no-op — same tolerance as ApprovalManager. */
  resolve(id: string, answer: UserQuestionAnswer): boolean {
    return this.settle(id, answer, answer.behavior === "completed" ? "answered" : "cancelled");
  }

  /** Cancel every question outstanding for a session — called when the session
   *  is disposed/killed so cards close and the awaiting guardian promise (and
   *  the turn behind it) doesn't hang until timeout. */
  cancelForSession(sessionId: string): void {
    for (const id of [...this.pending.keys()]) {
      if (this.pending.get(id)?.request.sessionId === sessionId) this.settle(id, { behavior: "cancelled" }, "cancelled");
    }
  }

  private settle(id: string, answer: UserQuestionAnswer, status: QuestionStatus): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
    pending.request.status = status;
    this.pending.delete(id);
    pending.resolve(answer);
    for (const l of this.resolvedListeners) l(pending.request);
    return true;
  }
}

/**
 * Defensive shape-check for an AskUserQuestion tool input's `questions` array.
 * Returns null (rather than throwing or forwarding a partial item) on anything
 * that doesn't look like a real UserQuestionItem[], so a malformed call degrades
 * to "let the tool run un-intercepted" instead of reaching QuestionCard (which
 * has no ErrorBoundary above it) with e.g. a missing `options` array.
 */
export function validQuestions(value: unknown): UserQuestionItem[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  for (const q of value as Array<Record<string, unknown>>) {
    if (typeof q?.question !== "string" || typeof q?.header !== "string") return null;
    if (!Array.isArray(q.options) || q.options.length < 2) return null;
    for (const opt of q.options as Array<Record<string, unknown>>) {
      if (typeof opt?.label !== "string") return null;
    }
  }
  return value as UserQuestionItem[];
}

/** Case-insensitive match for the AskUserQuestion tool across runtimes. Pi's
 *  "stealth" naming mirrors Claude Code exactly ("AskUserQuestion"); other
 *  agents may vary case, so normalize. */
export function isAskUserQuestionTool(toolName: string): boolean {
  return toolName.toLowerCase() === "askuserquestion";
}

/**
 * Format the user's answer into the tool result text handed back to the agent.
 * The interceptor delivers this through each runtime's block/deny channel (the
 * only host-supplied-result mechanism both pi and the Claude SDK expose), so it
 * reads as a plain statement of what the user chose rather than an error.
 */
export function formatQuestionResult(questions: UserQuestionItem[], answer: UserQuestionAnswer): string {
  if (answer.behavior === "cancelled") {
    return "The user dismissed the question(s) without answering. Proceed using your best judgment, or ask again if you truly cannot continue.";
  }
  const lines = questions.map((q) => {
    const a = answer.answers[q.question];
    return `- ${q.header}: ${a && a.trim() ? a : "(no answer)"}`;
  });
  return `The user answered your question(s):\n${lines.join("\n")}`;
}
