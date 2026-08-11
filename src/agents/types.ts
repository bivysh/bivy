// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { SandboxTier } from "../harness/sandbox.js";
import type { AttachToChatFn, RuntimeCapabilities } from "../runtime/types.js";
import type { AgentIntegrationOrigin } from "./definition.js";

/** Session construction inputs supplied by the Bivy host to every integration. */
export interface AgentSessionOptions {
  /** Override the integration id; normally assigned by the registry. */
  runtime?: string;
  /** Node credential-vault directory. Integrations do not own this directory. */
  credsDir: string;
  /** Legacy Pi path retained while the Pi integration migrates to its RPC bridge. */
  piDir: string;
  /** Bivy session metadata/transcript directory. */
  sessionsDir: string;
  /** Per-session sandbox tier override. */
  sandbox?: SandboxTier;
  /** Host callback exposed through an agent bridge when supported. */
  attachToChat?: AttachToChatFn;
}

export type AgentAvailability = "available" | "planned" | "external";
export type AgentSupportTier = "supported" | "beta" | "experimental" | "planned";
export type AgentProtectionLevel = "native-sandbox" | "tool-controls" | "mcp-controls" | "user-permissions";
export type AgentCertification = "release-tested" | "adapter-tested" | "unverified";

export interface AgentInstallCommand {
  command: string;
  args: string[];
  display: string;
}

export interface AgentInstallInfo {
  label: string;
  description?: string;
  /** Human-readable command shown to the user; execution remains server allowlisted. */
  command: string;
}

/** Node-facing description of one concrete integration path to an upstream agent. */
export interface AgentInfo {
  id: string;
  executionMode?: "protocol" | "structured-pipe" | "pipe" | "pty";
  displayName: string;
  description: string;
  status: AgentAvailability;
  packageName?: string;
  language?: string;
  capabilities: Partial<RuntimeCapabilities>;
  supportTier: AgentSupportTier;
  /** Adapter fact consumed by the shared protection classifier. */
  nativeSandbox?: boolean;
  protectionLevel?: AgentProtectionLevel;
  protectionLabel?: string;
  protectionDetail?: string;
  certification?: AgentCertification;
  /** Package or explicit node configuration that supplied this integration. */
  source?: AgentIntegrationOrigin;
  testedVersion?: string;
  authOwner?: "bivy" | "agent" | "mixed";
  notes?: string;
  install?: AgentInstallInfo;
}
