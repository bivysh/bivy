// SPDX-License-Identifier: AGPL-3.0-only
// Pure projection for all active-session response/attention queues.

import type { ServerEvent } from "./protocol.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AttentionApproval { id: string; sessionId?: string; [key: string]: unknown }
export interface AttentionQuestion { id: string; sessionId?: string; questions: AttentionQuestionItem[]; createdAt?: number }
export interface AttentionQuestionItem { question: string; header: string; options: Array<{ label: string; description?: string; preview?: string }>; multiSelect?: boolean }
export interface AttentionTurn { sessionId: string; trigger: "stalled" | "wedged"; idleMs: number; at: number; message: string }
export interface AttentionValue { approvals: AttentionApproval[]; questions: AttentionQuestion[]; turnAttentions: AttentionTurn[] }
export interface AttentionRowCommand { sessionId: string; status: "needs_action" | "idle" | "working"; needsAction: boolean; updatedAt?: number }
export interface AttentionFoldResult { handled: boolean; value: AttentionValue; row?: AttentionRowCommand }

function validQuestions(raw: unknown): AttentionQuestionItem[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  for (const item of raw) {
    if (!item || typeof item !== "object" || typeof item.question !== "string" || typeof item.header !== "string") return undefined;
    if (!Array.isArray(item.options) || item.options.length < 2 || item.options.some((option: any) => typeof option?.label !== "string")) return undefined;
  }
  return raw as AttentionQuestionItem[];
}
function stillNeeds(value: AttentionValue, sessionId: string): boolean {
  return value.approvals.some((item) => item.sessionId === sessionId) || value.questions.some((item) => item.sessionId === sessionId) || value.turnAttentions.some((item) => item.sessionId === sessionId);
}

export function foldAttentionEvent(input: AttentionValue, event: ServerEvent, now: number): AttentionFoldResult {
  const e = event as any;
  switch (event.type) {
    case "approval.created": {
      const approval = (e.approval || event) as AttentionApproval;
      if (!approval?.id) return { handled: true, value: input };
      const value = { ...input, approvals: [...input.approvals.filter((item) => item.id !== approval.id), approval] };
      return { handled: true, value, ...(approval.sessionId ? { row: { sessionId: approval.sessionId, status: "needs_action", needsAction: true, updatedAt: now } } : {}) };
    }
    case "approval.resolved": case "approval.removed": {
      const id = String(e.id || e.approvalId || "");
      const resolved = input.approvals.find((item) => item.id === id);
      const value = { ...input, approvals: input.approvals.filter((item) => item.id !== id) };
      const sid = resolved?.sessionId;
      return { handled: true, value, ...(sid && !stillNeeds(value, sid) ? { row: { sessionId: sid, status: "idle", needsAction: false } } : {}) };
    }
    case "session.question": {
      const id = String(e.requestId || ""); const questions = validQuestions(e.questions);
      if (!id || !questions) return { handled: true, value: input };
      const request: AttentionQuestion = { id, ...(e.sessionId ? { sessionId: String(e.sessionId) } : {}), questions, createdAt: Number(e.createdAt) || now };
      const value = { ...input, questions: [...input.questions.filter((item) => item.id !== id), request] };
      return { handled: true, value, ...(request.sessionId ? { row: { sessionId: request.sessionId, status: "needs_action", needsAction: true, updatedAt: now } } : {}) };
    }
    case "session.question.resolved": {
      const id = String(e.requestId || e.id || ""); const resolved = input.questions.find((item) => item.id === id);
      const value = { ...input, questions: input.questions.filter((item) => item.id !== id) };
      const sid = resolved?.sessionId;
      return { handled: true, value, ...(sid && !stillNeeds(value, sid) ? { row: { sessionId: sid, status: "idle", needsAction: false } } : {}) };
    }
    case "session.turn_attention": {
      const sessionId = String(e.sessionId || ""); const trigger = e.trigger === "wedged" || e.trigger === "stalled" ? e.trigger : undefined;
      if (!sessionId || !trigger) return { handled: true, value: input };
      const request: AttentionTurn = { sessionId, trigger, idleMs: Math.max(0, Number(e.idleMs) || 0), at: Number(e.at) || now, message: String(e.message || "This turn may be stuck. Stop it or keep waiting?") };
      return { handled: true, value: { ...input, turnAttentions: [...input.turnAttentions.filter((item) => item.sessionId !== sessionId), request] }, row: { sessionId, status: "needs_action", needsAction: true, updatedAt: now } };
    }
    case "session.turn_attention.resolved": {
      const sessionId = String(e.sessionId || ""); if (!sessionId) return { handled: true, value: input };
      const value = { ...input, turnAttentions: input.turnAttentions.filter((item) => item.sessionId !== sessionId) };
      return { handled: true, value, ...(!stillNeeds(value, sessionId) ? { row: { sessionId, status: "working", needsAction: false } } : {}) };
    }
    default: return { handled: false, value: input };
  }
}
