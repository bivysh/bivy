// SPDX-License-Identifier: AGPL-3.0-only

export interface ConnectionFacts {
  direct: boolean;
  solo: boolean;
  signedIn: boolean;
  currentNodeId: string | null;
}

export type ConnectionRequirement =
  | { type: "ready" }
  | { type: "authentication-required" }
  | { type: "node-required" };

export type NodeConnectionEvent =
  | { type: "node-connection.selection-requested"; nodeId: string }
  | { type: "node-connection.requirement-evaluated"; requirement: ConnectionRequirement };

export interface NodeConnectionDependencies {
  selectNode(nodeId: string): void;
  emit(event: NodeConnectionEvent): void;
}

/** Connection policy and node-selection intent, independent of transport/store. */
export class NodeConnectionCoordinator {
  constructor(private readonly deps: NodeConnectionDependencies) {}

  requirement(facts: ConnectionFacts): ConnectionRequirement {
    const requirement: ConnectionRequirement = !facts.direct && !facts.solo && !facts.signedIn
      ? { type: "authentication-required" }
      : !facts.direct && facts.signedIn && !facts.currentNodeId
        ? { type: "node-required" }
        : { type: "ready" };
    this.deps.emit({ type: "node-connection.requirement-evaluated", requirement });
    return requirement;
  }

  selectNode(nodeId: string): void {
    this.deps.emit({ type: "node-connection.selection-requested", nodeId });
    this.deps.selectNode(nodeId);
  }
}
