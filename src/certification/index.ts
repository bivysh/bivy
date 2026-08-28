// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentInfo } from "../agents/types.js";
import { CERTIFICATION_MATRIX } from "./generated.js";

export type CertificationEntry = (typeof CERTIFICATION_MATRIX.agents)[number];

export function certificationEntry(id: string): CertificationEntry | undefined {
  return CERTIFICATION_MATRIX.agents.find((entry) => entry.id === id);
}

/**
 * Supported means Bivy maintains a wrapper for this integration. Certification is
 * a separate fidelity signal: an active matrix entry verifies the richer release-
 * tested capability set for a pinned adapter version, while drift or a different
 * configured path keeps the wrapper Supported but marks the capability surface as
 * adapter-tested instead of release-tested.
 */
export function applyCertification(runtime: AgentInfo): AgentInfo {
  if (runtime.supportTier !== "supported") return runtime;
  const entry = certificationEntry(runtime.id);
  const eligible = entry?.status === "active"
    && runtime.executionMode === entry.executionMode
    && runtime.testedVersion === entry.pinnedVersion
    && entry.capabilities.every((capability) => runtime.capabilities[capability as keyof typeof runtime.capabilities] === true);
  if (!eligible) {
    return {
      ...runtime,
      certification: runtime.certification ?? "adapter-tested",
      notes: `${runtime.notes ? `${runtime.notes} ` : ""}This wrapper is maintained by Bivy; its current configured path is adapter-tested rather than release-tested.`,
    };
  }
  return { ...runtime, certification: "release-tested", testedVersion: entry.pinnedVersion };
}
