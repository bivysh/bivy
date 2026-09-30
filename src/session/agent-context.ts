// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { SessionApp } from "../apps/types.js";
import type { SessionPresence } from "./presence.js";

/** What `bivy context` asks the node for: where the calling agent's session
 *  runs, who last drove it, and what it has published. Plain data so it can be
 *  served over HTTP and, later, as an MCP resource. */
export interface AgentContext {
  session: {
    id: string;
    name?: string;
    agent: string;
    agentName?: string;
    workspace: string;
    branch?: string;
    prUrl?: string;
    forkedFrom?: string;
    delegatedFrom?: string;
    busy: boolean;
  };
  machine: { name: string; platform: string; arch: string };
  /** Some device has the app open right now (not necessarily on this session). */
  userConnected: boolean;
  /** The device that last sent input, if any: a hint for whether the user is at a keyboard. */
  lastDriver?: { label: string; via: string; at: number };
  apps: { id: string; name: string; views: { id: string; name: string; kind: string }[] }[];
  previewAvailable: boolean;
}

export interface AgentContextInput {
  session: AgentContext["session"];
  machine: AgentContext["machine"];
  presence: SessionPresence;
  userConnected: boolean;
  apps: SessionApp[];
  previewAvailable: boolean;
}

export function buildAgentContext(input: AgentContextInput): AgentContext {
  const driver = input.presence.driver;
  return {
    session: input.session,
    machine: input.machine,
    userConnected: input.userConnected,
    ...(driver ? { lastDriver: { label: driver.label, via: driver.via, at: driver.at } } : {}),
    apps: input.apps.map((app) => ({
      id: app.id,
      name: app.name,
      views: app.views.map((view) => ({ id: view.id, name: view.name, kind: view.kind })),
    })),
    previewAvailable: input.previewAvailable,
  };
}
