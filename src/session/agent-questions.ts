// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { randomUUID } from "node:crypto";
import type { QuestionManager } from "../question.js";
import type { UserQuestionItem } from "../runtime/types.js";

/**
 * Questions an agent asks with `bivy ask`. Any agent with a shell can raise
 * the same question card the AskUserQuestion interception shows (and the same
 * "needs your input" push), then block on the answer or come back for it.
 * Settled questions are kept a while so a caller that timed out can still
 * read the answer.
 */
export type AskStatus = "pending" | "answered" | "dismissed" | "expired";

export interface AskResult {
  id: string;
  sessionId: string;
  status: AskStatus;
  /** Question text → the user's answer (options joined by ", "), when answered. */
  answers?: Record<string, string>;
}

export const MAX_ASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const KEEP_SETTLED_MS = 24 * 60 * 60 * 1000;
const KEEP_MAX = 200;

/** Validates `bivy ask` input: 1–4 questions, each with text, a short header and
 *  none (a free-text answer) or 2–8 options. Returns an error message, or the questions. */
export function askQuestionsFrom(value: unknown): UserQuestionItem[] | string {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return "Ask 1 to 4 questions.";
  const out: UserQuestionItem[] = [];
  for (const raw of value as Array<Record<string, unknown>>) {
    const question = typeof raw?.question === "string" ? raw.question.trim() : "";
    if (!question || question.length > 1000) return "Each question needs text (up to 1000 characters).";
    const header = typeof raw.header === "string" && raw.header.trim() ? raw.header.trim().slice(0, 40) : "Question";
    const options = Array.isArray(raw.options) ? raw.options : [];
    if (options.length === 1 || options.length > 8) return "Offer 2 to 8 options, or none for a free-text answer.";
    const labels = options.map((o) => (typeof o === "string" ? o : (o as { label?: unknown })?.label)).map((l) => (typeof l === "string" ? l.trim() : ""));
    if (labels.some((l) => !l || l.length > 200)) return "Each option needs a label (up to 200 characters).";
    if (new Set(labels).size !== labels.length) return "Options must be different.";
    out.push({ question, header, options: labels.map((label) => ({ label })), ...(raw.multiSelect === true ? { multiSelect: true } : {}) });
  }
  if (new Set(out.map((q) => q.question)).size !== out.length) return "Questions must be different.";
  return out;
}

export class AgentQuestions {
  private readonly results = new Map<string, AskResult & { settledAt?: number }>();
  private readonly waiters = new Map<string, Set<() => void>>();

  /** How each of our questions settled. QuestionManager reports it to onResolved
   *  listeners synchronously, before the request's promise callbacks run. */
  private readonly settled = new Map<string, string>();

  constructor(private readonly questions: QuestionManager, private readonly now: () => number = Date.now) {
    questions.onResolved((request) => { if (this.results.has(request.id)) this.settled.set(request.id, request.status); });
  }

  /** Raise the card and return at once; the answer lands in `get`/`wait`. */
  ask(sessionId: string, items: UserQuestionItem[], timeoutMs: number): AskResult {
    this.prune();
    const id = randomUUID();
    const result: AskResult & { settledAt?: number } = { id, sessionId, status: "pending" };
    this.results.set(id, result);
    void this.questions.request({ id, sessionId, questions: items, timeoutMs: Math.min(Math.max(timeoutMs, 1000), MAX_ASK_TIMEOUT_MS) }).then((answer) => {
      const status = this.settled.get(id);
      this.settled.delete(id);
      result.status = answer.behavior === "completed" ? "answered" : status === "expired" ? "expired" : "dismissed";
      if (answer.behavior === "completed") result.answers = answer.answers;
      result.settledAt = this.now();
      for (const wake of this.waiters.get(id) ?? []) wake();
      this.waiters.delete(id);
    });
    return this.view(result);
  }

  get(sessionId: string, id: string): AskResult | undefined {
    const result = this.results.get(id);
    return result && result.sessionId === sessionId ? this.view(result) : undefined;
  }

  /** Resolves when the question settles or after `ms`, whichever is first. */
  async wait(sessionId: string, id: string, ms: number): Promise<AskResult | undefined> {
    const result = this.results.get(id);
    if (!result || result.sessionId !== sessionId) return undefined;
    if (result.status === "pending") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done() { clearTimeout(timer); resolve(); }
        const set = this.waiters.get(id) ?? new Set();
        set.add(done);
        this.waiters.set(id, set);
      });
    }
    return this.view(result);
  }

  private view(result: AskResult): AskResult {
    return { id: result.id, sessionId: result.sessionId, status: result.status, ...(result.answers ? { answers: { ...result.answers } } : {}) };
  }

  private prune(): void {
    const cutoff = this.now() - KEEP_SETTLED_MS;
    for (const [id, result] of this.results) if (result.settledAt !== undefined && (result.settledAt < cutoff || this.results.size > KEEP_MAX)) this.results.delete(id);
  }
}
