// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import type { UserQuestionAnswer, UserQuestionItem } from "./runtime/types.js";

/**
 * MCP elicitation on Bivy's question card. An MCP server asks the user for
 * something mid-call: a small form (a flat JSON Schema of strings, numbers,
 * booleans and choices) or a page to open (`url` mode, such as a sign-in).
 * Agents hand these to their host in the same MCP shape (the Claude Agent SDK's
 * onElicitation, Codex's mcpServer/elicitation/request), so an adapter raises
 * it as a call to ELICITATION_TOOL with the request as input, the guardian
 * answers it on the card every agent already uses, and the adapter returns the
 * structured result to the server. No adapter maps schemas itself.
 */
export const ELICITATION_TOOL = "McpElicitation";

export const isElicitationTool = (toolName: string) => toolName === ELICITATION_TOOL;

export interface ElicitationRequest {
  serverName?: string;
  /** A short label for the server or tool, when the agent has one. */
  displayName?: string;
  message: string;
  mode?: "form" | "url";
  url?: string;
  requestedSchema?: unknown;
}

type Value = string | number | boolean | string[];

export interface ElicitationResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, Value>;
}

type Schema = Record<string, unknown>;
type Choice = { value: string; label: string };

/** A form field on the card: the question, and how its answer reads back. */
interface Field {
  key: string;
  required: boolean;
  item: UserQuestionItem;
  read: (answer: string) => Value | undefined;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const asSchema = (v: unknown): Schema => (v && typeof v === "object" && !Array.isArray(v) ? (v as Schema) : {});

/** The values a choice field allows: `enum` (with legacy `enumNames`), or
 *  titled `oneOf`/`anyOf` entries of `{ const, title }`. */
function choicesOf(schema: Schema): Choice[] {
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.filter((v): v is string => typeof v === "string").map((value, i) => ({ value, label: str(names[i]) || value }));
  }
  const titled = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : [];
  return titled.map(asSchema).filter((o) => typeof o.const === "string").map((o) => ({ value: o.const as string, label: str(o.title) || (o.const as string) }));
}

/** Picked labels back to values. The card joins a multi-select with ", ". */
function picked(choices: Choice[], answer: string): string[] {
  const joined = `, ${answer}, `;
  return choices.filter((c) => joined.includes(`, ${c.label}, `)).map((c) => c.value);
}

const inRange = (n: number, s: Schema) =>
  (typeof s.minimum !== "number" || n >= s.minimum) && (typeof s.maximum !== "number" || n <= s.maximum);

/** Each field kind as a row: what the card shows for it and how its answer
 *  parses. The first row that matches a property's schema wins. */
const KINDS: Array<{
  matches: (s: Schema) => boolean;
  options: (s: Schema) => string[];
  multiSelect?: boolean;
  read: (answer: string, s: Schema) => Value | undefined;
}> = [
  {
    matches: (s) => s.type === "array",
    options: (s) => choicesOf(asSchema(s.items)).map((c) => c.label),
    multiSelect: true,
    read: (a, s) => {
      const values = picked(choicesOf(asSchema(s.items)), a);
      return values.length >= (typeof s.minItems === "number" ? s.minItems : 1) && (typeof s.maxItems !== "number" || values.length <= s.maxItems) ? values : undefined;
    },
  },
  {
    matches: (s) => choicesOf(s).length > 0,
    options: (s) => choicesOf(s).map((c) => c.label),
    read: (a, s) => choicesOf(s).find((c) => c.label === a.trim())?.value,
  },
  {
    matches: (s) => s.type === "boolean",
    options: () => ["Yes", "No"],
    read: (a) => (a === "Yes" ? true : a === "No" ? false : undefined),
  },
  {
    matches: (s) => s.type === "number" || s.type === "integer",
    options: () => [],
    read: (a, s) => {
      const n = a.trim() ? Number(a.trim()) : NaN;
      return Number.isFinite(n) && (s.type !== "integer" || Number.isInteger(n)) && inRange(n, s) ? n : undefined;
    },
  },
  {
    matches: () => true,
    options: () => [],
    read: (a, s) => {
      const v = a.trim();
      return v && (typeof s.minLength !== "number" || v.length >= s.minLength) && (typeof s.maxLength !== "number" || v.length <= s.maxLength) ? v : undefined;
    },
  },
];

function formFields(request: ElicitationRequest): Field[] {
  const schema = asSchema(request.requestedSchema);
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : []);
  // Required fields first: some agents pass the properties sorted by name.
  const props = Object.entries(asSchema(schema.properties)).sort(([a], [b]) => Number(required.has(b)) - Number(required.has(a)));
  const seen = new Set<string>();
  return props.map(([key, raw], i) => {
    const s = asSchema(raw);
    const kind = KINDS.find((k) => k.matches(s))!;
    const name = str(s.title) || key;
    const about = str(s.description);
    const optional = !required.has(key);
    const label = `${name}${optional ? " (optional)" : ""}`;
    // A field reads as its name, or as its description under its name. The
    // server's message heads the first one, whose eyebrow names the server.
    let question = about || label;
    if (i === 0) question = `${request.message} — ${question}`;
    if (seen.has(question)) question = `${question} (${key})`;
    seen.add(question);
    const options = kind.options(s).map((label) => ({ label }));
    return {
      key,
      required: !optional,
      item: {
        question,
        header: [i === 0 ? header(request) : "", about ? label : ""].filter(Boolean).join(" · ").slice(0, 40),
        options,
        ...(kind.multiSelect ? { multiSelect: true } : {}),
        // The schema allows only these values, so "Other…" text could never be sent.
        ...(options.length ? { closed: true } : {}),
        ...(optional ? { optional: true } : {}),
      },
      read: (answer) => kind.read(answer, s),
    };
  });
}

const header = (request: ElicitationRequest) => (str(request.displayName) || str(request.serverName) || "MCP server").slice(0, 40);
const ACCEPT = "Continue";
const DECLINE = "Decline";
const SAFE_URL = /^https?:\/\/\S+$/i;

/** The card for an elicitation, or null when Bivy can't show it (a URL that
 *  isn't a web page): the adapter then declines. */
export function elicitationQuestions(request: ElicitationRequest): UserQuestionItem[] | null {
  if (!str(request.message)) return null;
  if (request.mode === "url") {
    return SAFE_URL.test(str(request.url)) ? [{ question: request.message, header: header(request), options: [], url: str(request.url) }] : null;
  }
  const fields = formFields(request);
  // No fields: the server only wants a go-ahead.
  if (!fields.length) return [{ question: request.message, header: header(request), options: [{ label: ACCEPT }, { label: DECLINE }], closed: true }];
  return fields.map((f) => f.item);
}

/** The user's answer on the card as the server's result. Skip declines; a
 *  reply in the chat, a timeout or an abort cancels. A required field the
 *  answer doesn't fit cancels too, rather than sending what the schema refuses. */
export function elicitationResult(request: ElicitationRequest, answer: UserQuestionAnswer): ElicitationResult {
  if (answer.behavior === "cancelled") return { action: "decline" };
  if (answer.behavior === "replied") return { action: "cancel" };
  const questions = elicitationQuestions(request) ?? [];
  if (request.mode === "url") return { action: answer.answers[questions[0]?.question ?? ""] === "Done" ? "accept" : "decline" };
  const fields = formFields(request);
  if (!fields.length) return { action: answer.answers[questions[0]?.question ?? ""] === ACCEPT ? "accept" : "decline" };
  const content: Record<string, Value> = {};
  for (const field of fields) {
    const value = field.read(answer.answers[field.item.question] ?? "");
    if (value !== undefined) content[field.key] = value;
    else if (field.required) return { action: "cancel" };
  }
  return { action: "accept", content };
}
