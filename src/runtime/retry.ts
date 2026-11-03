// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import type { RuntimeEvent } from "./types.js";

/**
 * The agent's model call failed and the agent is trying again on its own
 * (overload, rate limit, dropped stream). Every runtime reports it in this one
 * shape, `agent_retry`, so clients show the same "Retrying (2/5)…" status for
 * any agent. The turn is still running; it is not a failure.
 */
export interface AgentRetry {
  attempt?: unknown;
  maxAttempts?: unknown;
  delayMs?: unknown;
  error?: unknown;
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined);

export function agentRetryEvent(retry: AgentRetry): RuntimeEvent {
  const attempt = count(retry.attempt);
  const maxAttempts = count(retry.maxAttempts);
  const delayMs = count(retry.delayMs);
  const error = typeof retry.error === "string" ? retry.error.trim() : "";
  return {
    type: "agent_retry",
    ...(attempt ? { attempt } : {}),
    ...(maxAttempts ? { maxAttempts } : {}),
    ...(delayMs ? { delayMs } : {}),
    ...(error ? { error } : {}),
  };
}
