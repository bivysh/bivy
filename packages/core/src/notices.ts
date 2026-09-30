// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

/** A message the agent sent with `bivy notify`. Mirrors
 *  src/session/notices.ts; the block string MUST match there. */
export interface AgentNotice {
  id: string;
  text: string;
  urgent?: boolean;
}

export const NOTICE_BLOCK = "bivy_notice";

export function isAgentNotice(value: unknown): value is AgentNotice {
  if (!value || typeof value !== "object") return false;
  const n = value as Partial<AgentNotice>;
  return typeof n.id === "string" && n.id.length > 0 && typeof n.text === "string" && n.text.length > 0
    && (n.urgent === undefined || typeof n.urgent === "boolean");
}
