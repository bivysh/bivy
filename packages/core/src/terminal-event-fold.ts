// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

export interface RunTerminalValue {
  termId: string;
  lastActivityAt?: number;
}

export interface TerminalIndexValue<TTerminal extends RunTerminalValue = RunTerminalValue> {
  readonly runTerminals: readonly TTerminal[];
  readonly tuiSessions: readonly string[];
}

export interface TerminalEventData {
  type?: unknown;
  terminals?: unknown;
  terminal?: unknown;
  termId?: unknown;
  sessionId?: unknown;
  active?: unknown;
  at?: unknown;
}

export type TerminalFoldResult<T> =
  | { handled: false; value: T }
  | { handled: true; value: T };

function terminalFrom(value: unknown): RunTerminalValue | undefined {
  if (!value || typeof value !== "object") return undefined;
  const terminal = value as Record<string, unknown>;
  return typeof terminal.termId === "string" ? terminal as unknown as RunTerminalValue : undefined;
}

/** Pure projection of terminal inventory/activity and chat↔TUI ownership. */
export function foldTerminalEvent<TTerminal extends RunTerminalValue, TValue extends TerminalIndexValue<TTerminal>>(
  value: TValue,
  event: TerminalEventData,
  now: number,
): TerminalFoldResult<TValue> {
  if (event.type === "terminal.list") {
    const runTerminals = Array.isArray(event.terminals)
      ? event.terminals.map(terminalFrom).filter((terminal): terminal is RunTerminalValue => Boolean(terminal)) as TTerminal[]
      : [];
    return { handled: true, value: { ...value, runTerminals } };
  }
  if (event.type === "terminal.created") {
    const terminal = terminalFrom(event.terminal) as TTerminal | undefined;
    if (!terminal) return { handled: true, value };
    return {
      handled: true,
      value: {
        ...value,
        runTerminals: [terminal, ...value.runTerminals.filter((item) => item.termId !== terminal.termId)],
      },
    };
  }
  if (event.type === "terminal.activity") {
    const termId = String(event.termId || "");
    if (!termId) return { handled: true, value };
    const at = Number(event.at) || now;
    return {
      handled: true,
      value: {
        ...value,
        runTerminals: value.runTerminals.map((terminal) =>
          terminal.termId === termId ? { ...terminal, lastActivityAt: at } : terminal,
        ),
      },
    };
  }
  if (event.type === "terminal.closed" || event.type === "terminal.exit") {
    const termId = String(event.termId || "");
    if (!termId) return { handled: true, value };
    return {
      handled: true,
      value: { ...value, runTerminals: value.runTerminals.filter((terminal) => terminal.termId !== termId) },
    };
  }
  if (event.type === "terminal.tui") {
    const sessionId = String(event.sessionId || "");
    if (!sessionId) return { handled: true, value };
    const active = Boolean(event.active);
    const present = value.tuiSessions.includes(sessionId);
    if (active === present) return { handled: true, value };
    return {
      handled: true,
      value: {
        ...value,
        tuiSessions: active
          ? [...value.tuiSessions, sessionId]
          : value.tuiSessions.filter((id) => id !== sessionId),
      },
    };
  }
  return { handled: false, value };
}
