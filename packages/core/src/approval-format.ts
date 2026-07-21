// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// Approval-card formatting: severity, plain-language consequence, and the
// critical-action gate on "remember this choice".
//
// Ported from the legacy client (public/bivy-ui.js: MeshUI.approvalSeverity,
// approvalTitle, approvalIcon, approvalConsequence, approvalFields,
// approvalCommand). Kept framework-agnostic and pure, mirroring tool-format.ts,
// so the React view (and later Expo) render from the same computed shape and
// the severity heuristic is unit-testable.
//
// approvalSeverity is safety-relevant, not cosmetic: legacy only offers a
// "remember this choice" / always-allow option when severity !== "critical" —
// a destructive action (rm -rf, drop table, shutdown, …) always requires a
// fresh, explicit approval. Keep that gate wired to this same function.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ApprovalSeverity = "critical" | "high" | "medium" | "low";

function safeString(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compactPath(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) return "";
  const parts = text.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : text;
}

export function approvalToolInput(approval: any): Record<string, unknown> {
  return approval?.toolInput ?? approval?.input ?? approval?.args ?? approval?.arguments ?? approval?.toolCall?.arguments ?? {};
}

export function approvalToolName(approval: any): string {
  return String(approval?.toolName || approval?.name || approval?.tool?.name || approval?.tool || approval?.toolCall?.name || "tool").toLowerCase();
}

/** Destructive/permanent > sends-data/external > file-changing > everything else. */
export function approvalSeverity(approval: any): ApprovalSeverity {
  const input = approvalToolInput(approval);
  const name = approvalToolName(approval);
  const text = `${name} ${Object.values(input).map(safeString).join(" ")}`.toLowerCase();
  if (/\b(rm\s+-rf|rm\s+-r|delete|unlink|drop\s+table|shutdown|reboot|format|wipe)\b/.test(text)) return "critical";
  if (/\b(send|email|mail|post|publish|deploy|push|scp|curl|wget|ssh|chmod|chown|sudo)\b/.test(text)) return "high";
  if (/\b(write|edit|mv|move|cp|copy|install|update|create)\b/.test(text)) return "medium";
  return "low";
}

export function approvalTitle(approval: any): string {
  const input = approvalToolInput(approval);
  const name = approvalToolName(approval);
  const target = (input as any).path || (input as any).file || (input as any).filePath || (input as any).pathname;
  if (name.includes("bash") || name.includes("shell")) return "Run this command?";
  if (name.includes("mail") || name.includes("email") || name.includes("send")) return "Agent wants to send a message";
  if (name.includes("edit")) return `Edit ${compactPath(target) || "a file"}?`;
  if (name.includes("write")) return `Write ${compactPath(target) || "a file"}?`;
  return `Allow ${name}?`;
}

export function approvalConsequence(approval: any, severity: ApprovalSeverity = approvalSeverity(approval)): string {
  const input = approvalToolInput(approval) as any;
  const name = approvalToolName(approval);
  const command = String(input.command || input.cmd || input.shell || "").trim();
  const target = input.path || input.file || input.filePath || input.pathname || input.cwd || input.directory;
  const recipients = input.to || input.recipients || input.recipient;
  const recipientCount = Array.isArray(recipients) ? recipients.length : recipients ? String(recipients).split(",").filter(Boolean).length : 0;
  const lower = `${name} ${command}`.toLowerCase();
  if (recipientCount || name.includes("mail") || name.includes("email") || /\b(sendmail|mail)\b/.test(lower)) {
    return recipientCount ? `This sends a message to ${recipientCount} recipient${recipientCount === 1 ? "" : "s"} immediately.` : "This sends a message immediately.";
  }
  if (severity === "critical") {
    return target ? `This can permanently change or delete data in ${target}. This may not be undoable.` : "This can permanently change or delete data. This may not be undoable.";
  }
  if (/\b(curl|wget|ssh|scp|git\s+push|deploy)\b/.test(lower)) return "This connects to an external service or publishes data outside this machine.";
  if (/\b(npm|bun|pnpm|yarn)\s+(install|add|update)\b/.test(lower)) return "This changes project dependencies on this machine.";
  if (name.includes("write") || name.includes("edit") || /\b(write|edit|mv|cp)\b/.test(lower)) return target ? `This changes files at ${target}.` : "This changes files in the workspace.";
  return "The agent is paused until you approve this action.";
}

export function approvalCommand(approval: any): string {
  const input = approvalToolInput(approval) as any;
  const name = approvalToolName(approval);
  if (name.includes("bash") || name.includes("shell")) return String(input.command || input.cmd || input.shell || "").trim();
  return "";
}

export function approvalFields(approval: any): Array<[string, string]> {
  const input = approvalToolInput(approval) as any;
  const name = approvalToolName(approval);
  const fields: Array<[string, string]> = [];
  const add = (label: string, value: unknown) => {
    const text = String(value ?? "").trim();
    if (text) fields.push([label, text.length > 420 ? `${text.slice(0, 420)}…` : text]);
  };
  add("Tool", name);
  add("File", input.path || input.file || input.filePath || input.pathname);
  add("Command", name.includes("bash") || name.includes("shell") ? "" : input.command);
  add("Find", input.oldText || input.search || input.find);
  add("Replace", input.newText || input.replace);
  add("Text", input.content || input.text);
  return fields;
}

export interface FormattedApproval {
  severity: ApprovalSeverity;
  title: string;
  consequence: string;
  command: string;
  fields: Array<[string, string]>;
  rawInput: string;
  /** Legacy only offers "remember this choice" / always-allow when this is
   *  true — never for a critical (destructive/irreversible) action. */
  canRemember: boolean;
}

export function formatApproval(approval: any): FormattedApproval {
  const severity = approvalSeverity(approval);
  const input = approvalToolInput(approval);
  let rawInput = "";
  try {
    rawInput = JSON.stringify(input, null, 2);
  } catch {
    rawInput = String(input);
  }
  return {
    severity,
    title: approvalTitle(approval),
    consequence: approvalConsequence(approval, severity),
    command: approvalCommand(approval),
    fields: approvalFields(approval),
    rawInput,
    canRemember: severity !== "critical",
  };
}
