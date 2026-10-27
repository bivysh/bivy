// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { randomUUID } from "node:crypto";
import type { QuestionManager } from "../question.js";
import type { UserQuestionItem } from "../runtime/types.js";
import { AGENT_SECRET_NAME } from "../secrets.js";

/**
 * Questions an agent asks with `bivy ask`. Any agent with a shell can raise
 * the same question card the AskUserQuestion interception shows (and the same
 * "needs your input" push), then block on the answer or come back for it.
 * Settled questions are kept a while so a caller that timed out can still
 * read the answer.
 *
 * A secret question (`bivy ask --secret NAME`) takes a hidden value on the
 * card. The value goes straight to `storeSecret` (the node vault) and the agent
 * reads back only `secret://NAME`, so it never enters the transcript or the
 * model's context.
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

export const secretRef = (name: string) => `secret://${name}`;

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
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (url && !/^https:\/\/\S+$/.test(url)) return "A link must be an https:// URL.";
    const code = typeof raw.code === "string" ? raw.code.trim() : "";
    if (code.length > 64) return "A code is up to 64 characters.";
    const command = typeof raw.command === "string" ? raw.command.trim() : "";
    // One line, no control characters: the card types it into a terminal, and a
    // newline there would run it before the user has read it.
    if (command.length > 1000 || /[\u0000-\u001f\u007f]/.test(command)) return "A command is one line (up to 1000 characters) with no control characters.";
    const extras = { ...(url ? { url } : {}), ...(code ? { code } : {}), ...(command ? { command } : {}) };
    const secret = raw.secret as { name?: unknown } | undefined;
    if (secret !== undefined) {
      const name = typeof secret?.name === "string" ? secret.name.trim() : "";
      if (!AGENT_SECRET_NAME.test(name)) return "A secret name is a letter, then letters, digits or underscores (up to 64), like STRIPE_API_KEY.";
      if (labels.length) return "A secret question takes no options.";
      out.push({ question, header: typeof raw.header === "string" && raw.header.trim() ? header : "Secret", options: [], secret: { name }, ...extras });
      continue;
    }
    const stepHeader = (url || command) && !(typeof raw.header === "string" && raw.header.trim()) ? "Your step" : header;
    out.push({ question, header: stepHeader, options: labels.map((label) => ({ label })), ...(raw.multiSelect === true ? { multiSelect: true } : {}), ...extras });
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

  constructor(
    private readonly questions: QuestionManager,
    private readonly now: () => number = Date.now,
    /** Keeps a secret answer; the agent only ever sees its reference. */
    private readonly storeSecret: (name: string, value: string, description: string) => void = () => { throw new Error("No secret store on this node."); },
  ) {
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
      if (answer.behavior === "completed") result.answers = this.keepSecrets(items, answer.answers);
      result.settledAt = this.now();
      for (const wake of this.waiters.get(id) ?? []) wake();
      this.waiters.delete(id);
    });
    return this.view(result);
  }

  /** Moves secret answers into the store, leaving their references in their place.
   *  An empty secret, or one the store refuses, reads back as no answer. */
  private keepSecrets(items: UserQuestionItem[], answers: Record<string, string>): Record<string, string> {
    const out = { ...answers };
    for (const item of items) {
      if (!item.secret) continue;
      const value = out[item.question] ?? "";
      out[item.question] = "";
      if (!value.trim()) continue;
      try {
        this.storeSecret(item.secret.name, value.trim(), item.question);
        out[item.question] = secretRef(item.secret.name);
      } catch { /* left empty: the agent sees no answer and can ask again */ }
    }
    return out;
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
