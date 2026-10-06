// SPDX-License-Identifier: AGPL-3.0-only
import { isCloudComputerNodeId } from "../../cloudDestinations.js";
import type {
  AccountNode,
  EphemeralMachine,
  EphemeralNodeConfig,
  SessionCorrelation,
} from "@bivy/core";

export interface EphemeralDependencies {
  listConfigs(): Promise<EphemeralNodeConfig[]>;
  direct(): boolean;
  currentNodeId(): string;
  nodes(): AccountNode[];
  correlations(): SessionCorrelation[];
  restoreManagedMachine(input: { configId: string; nodeId: string; sessionId: string; requestId?: string }): Promise<EphemeralMachine>;
  connectToNode(nodeId: string, timeoutMs?: number): Promise<void>;
  reportError(error: Error): void;
}

/** Deployment-provided cloud machines: listing profiles, and rebuilding a
 * session whose Machine was retired. Launch and teardown are server-side. */
export class EphemeralCoordinator {
  constructor(private readonly deps: EphemeralDependencies) {}

  listConfigs(): Promise<EphemeralNodeConfig[]> { return this.deps.listConfigs(); }

  async reprovision(nodeId: string, sessionId: string): Promise<void> {
    try {
      // The account's cloud computer keeps its sessions on its own disk: bringing
      // it back is a wake, and the control plane knows which machine that is.
      if (isCloudComputerNodeId(nodeId)) {
        await this.deps.restoreManagedMachine({ configId: "managed-default", nodeId, sessionId, requestId: `wake:${sessionId}:${Date.now()}` });
        await this.deps.connectToNode(nodeId, 120_000);
        return;
      }
      const correlation = this.deps.correlations().find((item) => item.nodeId === nodeId || item.sessionId === sessionId);
      if (correlation?.computeSource !== "managed") throw new Error("This session's machine can't be rebuilt.");
      if (!correlation.setupId) throw new Error("This cloud session no longer has a Machine profile to rebuild from.");
      await this.deps.restoreManagedMachine({
        configId: correlation.setupId, nodeId: correlation.nodeId, sessionId,
        // A new source-machine generation permits a new restore; retries and
        // fresh devices looking at the same correlation reuse one purchase.
        requestId: `restore:${sessionId}:${correlation.nodeId}:${correlation.machineId || "legacy"}`,
      });
      await this.deps.connectToNode(correlation.nodeId, 120_000);
    } catch (cause) {
      this.deps.reportError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  /** A retired cloud session is rebuildable; an enrolled node (even during a
   * transient disconnect) must reconnect, not request a second machine. */
  isCurrentNodeResumable(): boolean {
    if (this.deps.direct()) return false;
    const nodeId = this.deps.currentNodeId();
    if (!nodeId) return false;
    // A sleeping cloud computer wakes when a message is sent to it.
    if (isCloudComputerNodeId(nodeId)) return !this.deps.nodes().find((candidate) => candidate.id === nodeId)?.online;
    const correlation = this.deps.correlations().find((item) => item.nodeId === nodeId);
    if (correlation?.computeSource !== "managed") return false;
    return !this.deps.nodes().some((candidate) => candidate.id === nodeId);
  }
}
