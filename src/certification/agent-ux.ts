// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Scoring for the agent-UX eval (certification/agent-ux.json, run by
 * scripts/agent-ux-eval.ts): given what a real agent did in a session, did it
 * use Bivy the way the task needed? Pure, so the rules are testable without an
 * agent or a model.
 */

export type AgentUxExpectation =
  | { block: string; min?: number }
  | { asked: true }
  | { reply: string }
  | { file: string };

export interface AgentUxTask {
  id: string;
  prompt: string;
  answer?: string;
  files: Record<string, string>;
  expect: AgentUxExpectation[];
}

/** What the harness saw in one session. */
export interface AgentUxObservation {
  /** Chat card block type → how many the transcript holds. */
  blocks: Record<string, number>;
  /** The agent raised at least one question card. */
  asked: boolean;
  /** The agent's last message text. */
  reply: string;
  /** Workspace files afterwards, relative paths. */
  files: string[];
}

export interface AgentUxCheck { expectation: string; passed: boolean }

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
}

/** Every expectation of a task, checked against an observation. `vars` fills {name} placeholders. */
export function scoreAgentUx(expect: AgentUxExpectation[], seen: AgentUxObservation, vars: Record<string, string> = {}): AgentUxCheck[] {
  const fill = (text: string) => text.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
  return expect.map((rule) => {
    if ("block" in rule) {
      const min = rule.min ?? 1;
      return { expectation: `${min}+ ${rule.block}`, passed: (seen.blocks[rule.block] ?? 0) >= min };
    }
    if ("asked" in rule) return { expectation: "asked a question", passed: seen.asked };
    if ("reply" in rule) {
      const text = fill(rule.reply);
      return { expectation: `reply mentions "${text}"`, passed: seen.reply.toLowerCase().includes(text.toLowerCase()) };
    }
    const pattern = globToRegExp(rule.file);
    return { expectation: `file ${rule.file}`, passed: seen.files.some((file) => pattern.test(file)) };
  });
}

/** Count `bivy_*` chat card blocks anywhere in a history payload's messages. */
export function countCardBlocks(messages: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (!value || typeof value !== "object") return;
    const type = (value as { type?: unknown }).type;
    if (typeof type === "string" && type.startsWith("bivy_")) counts[type] = (counts[type] ?? 0) + 1;
    walk((value as { content?: unknown }).content);
  };
  walk(messages);
  return counts;
}
