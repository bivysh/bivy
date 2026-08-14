// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Sensitive launch material. Unlike EphemeralLaunchPlan, this value is never
// suitable for logs, analytics, persistence, or presentation.

import type { BootstrapOpts } from "./ephemeral-provider-ports.js";

export interface EphemeralExecutionEnvelopeInput {
  provider: string;
  nodeId: string;
  relayUrl: string;
  controlPlaneUrl: string;
  enrollmentToken: string;
  roomKeyB64: string;
  ttlMinutes?: number;
  repo?: string;
  hostedTasks?: boolean;
  githubToken?: string;
  hostedMint?: boolean;
  teardownOnAgentFinish?: boolean;
  debugKeepMachine?: boolean;
  restoreSessionId?: string;
}

/** Secret-bearing input consumed only at the provider effect edge. */
export interface EphemeralExecutionEnvelope {
  readonly bootstrap: BootstrapOpts;
}

export function createEphemeralExecutionEnvelope(input: EphemeralExecutionEnvelopeInput): EphemeralExecutionEnvelope {
  const label = input.nodeId.replace(/^eph-/, "");
  return {
    bootstrap: {
      relayUrl: input.relayUrl,
      controlPlaneUrl: input.controlPlaneUrl,
      enrollmentToken: input.enrollmentToken,
      e2eKeyB64: input.roomKeyB64,
      ttlMinutes: input.ttlMinutes,
      repo: input.repo,
      hostedTasks: input.hostedTasks,
      nodeLabel: input.hostedTasks ? label : undefined,
      githubToken: input.githubToken,
      hostedMint: input.hostedMint,
      provider: input.provider,
      teardownOnAgentFinish: input.teardownOnAgentFinish,
      debugKeepMachine: input.debugKeepMachine,
      restoreSessionId: input.restoreSessionId,
    },
  };
}
