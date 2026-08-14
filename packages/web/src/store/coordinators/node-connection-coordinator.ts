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

/** Pure policy for whether the app may dial a node. */
export class NodeConnectionCoordinator {
  requirement(facts: ConnectionFacts): ConnectionRequirement {
    if (!facts.direct && !facts.solo && !facts.signedIn) return { type: "authentication-required" };
    if (!facts.direct && facts.signedIn && !facts.currentNodeId) return { type: "node-required" };
    return { type: "ready" };
  }
}
