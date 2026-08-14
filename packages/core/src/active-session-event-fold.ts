// SPDX-License-Identifier: AGPL-3.0-only
// Pure decisions for focused-session lifecycle and chrome. Cache/subscription
// identity and command interpretation remain in SessionStore.

import type { ServerEvent } from "./protocol.js";
import { normalizeSessionState, normalizeUsage, sessionStatusFromState } from "./store-normalize.js";
import { humanizeError } from "./store-errors.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ActiveLifecycleInput {
  activeSessionId: string | null;
  working: boolean;
  workingLabel: string;
  opening: boolean;
  usage: unknown;
  changes: unknown;
  changesHistory: unknown[];
  checkpoints: unknown[];
  activeTitle: string;
  github: Record<string, unknown>;
  newChangeId?: string;
}
export type ActiveLifecycleCommand =
  | { kind: "row"; sessionId: string; patch: Record<string, unknown> }
  | { kind: "entry"; role: "system" | "error"; text: string; action?: string }
  | { kind: "model-auth"; provider: string; reason: string }
  | { kind: "rename"; sessionId: string; name: string }
  | { kind: "global-error"; message: string }
  | { kind: "reset-active" };
export interface ActiveLifecycleResult { handled: boolean; patch?: Partial<ActiveLifecycleInput>; commands: ActiveLifecycleCommand[] }

function foreign(activeSessionId: string | null, sessionId: unknown): boolean { return Boolean(sessionId) && sessionId !== activeSessionId; }

export function foldActiveSessionEvent(input: ActiveLifecycleInput, event: ServerEvent, now: number): ActiveLifecycleResult {
  const e = event as any; const sid = String(e.sessionId || "");
  switch (event.type) {
    case "session.state": {
      const state = normalizeSessionState(e.state ?? e.sessionState);
      if (!sid || !state) return { handled: true, commands: [] };
      return { handled: true, patch: sid === input.activeSessionId ? { working: state.agent === "working", ...(state.agent !== "working" ? { workingLabel: "" } : {}) } : undefined, commands: [{ kind: "row", sessionId: sid, patch: { sessionState: state, status: sessionStatusFromState(state), needsAction: state.displayStatus === "needs_attention" } }] };
    }
    case "session.renamed": {
      const commands: ActiveLifecycleCommand[] = [];
      if (e.name && sid) commands.push({ kind: "rename", sessionId: sid, name: String(e.name) });
      if (e.branch && sid) commands.push({ kind: "row", sessionId: sid, patch: { branch: String(e.branch) } });
      const focused = !sid || sid === input.activeSessionId;
      return { handled: true, patch: focused ? { ...(e.name ? { activeTitle: String(e.name) } : {}), ...(e.branch ? { github: { ...input.github, branch: String(e.branch) } } : {}) } : undefined, commands };
    }
    case "session.branch_renamed": return { handled: true, patch: (!sid || sid === input.activeSessionId) && e.branch ? { github: { ...input.github, branch: String(e.branch) } } : undefined, commands: e.branch && sid ? [{ kind: "row", sessionId: sid, patch: { branch: String(e.branch) } }] : [] };
    case "session.error": case "session.errored": {
      if (foreign(input.activeSessionId, e.sessionId)) return { handled: true, commands: [] };
      const message = humanizeError(String(e.error || e.errorMessage || "error"));
      return { handled: true, patch: { working: false, opening: false }, commands: e.sessionId ? [{ kind: "entry", role: "error", text: message }] : [{ kind: "global-error", message }] };
    }
    case "session.closed": return { handled: true, patch: sid === input.activeSessionId ? { working: false, workingLabel: "", opening: false } : undefined, commands: sid ? [{ kind: "row", sessionId: sid, patch: { status: "saved", needsAction: false } }] : [] };
    case "session.failed": return { handled: true, commands: sid ? [{ kind: "row", sessionId: sid, patch: { status: "failed", needsAction: false, failedAt: Number(e.failedAt) || now, updatedAt: now } }] : [] };
    case "session.notice": return { handled: true, commands: (!sid || sid === input.activeSessionId) && e.message ? [{ kind: "entry", role: "system", text: String(e.message), ...(typeof e.action === "string" ? { action: e.action } : {}) }] : [] };
    case "session.cloning": return { handled: true, patch: !sid || sid === input.activeSessionId ? { working: true, workingLabel: `Cloning ${e.repo || "repo"}…` } : undefined, commands: [] };
    case "session.auth_required": return { handled: true, commands: !foreign(input.activeSessionId, e.sessionId) && e.provider ? [{ kind: "model-auth", provider: String(e.provider), reason: String(e.reason || "") }] : [] };
    case "session.usage": return { handled: true, patch: foreign(input.activeSessionId, e.sessionId) ? undefined : { usage: normalizeUsage(e.usage) }, commands: [] };
    case "session.warning": return { handled: true, commands: !foreign(input.activeSessionId, e.sessionId) && e.warning ? [{ kind: "entry", role: "system", text: String(e.warning) }] : [] };
    case "session.changes": {
      if (foreign(input.activeSessionId, e.sessionId)) return { handled: true, commands: [] };
      const files = Array.isArray(e.changes) ? e.changes : [];
      if (!files.length) return { handled: true, patch: { changes: null }, commands: [] };
      const turn = { before: e.before ? String(e.before) : undefined, after: String(e.after ?? ""), files };
      return { handled: true, patch: { changes: turn, changesHistory: [...input.changesHistory, { ...turn, id: input.newChangeId ?? `change-${input.changesHistory.length + 1}`, at: now }] }, commands: [] };
    }
    case "session.rewound": return foreign(input.activeSessionId, e.sessionId) ? { handled: true, commands: [] } : { handled: true, patch: { changes: null }, commands: [{ kind: "entry", role: "system", text: "Rewound the workspace to an earlier checkpoint." }] };
    case "session.checkpoints": {
      if (foreign(input.activeSessionId, e.sessionId)) return { handled: true, commands: [] };
      const checkpoints = Array.isArray(e.checkpoints) ? e.checkpoints.map((item: any) => ({ id: String(item.id ?? ""), label: String(item.label ?? "checkpoint"), createdAt: Number(item.createdAt ?? 0) })).filter((item: any) => item.id) : [];
      return { handled: true, patch: { checkpoints }, commands: [] };
    }
    default: return { handled: false, commands: [] };
  }
}
