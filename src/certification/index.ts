// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentInfo } from "../agents/types.js";
import { CERTIFICATION_MATRIX } from "./generated.js";

export type CertificationEntry = (typeof CERTIFICATION_MATRIX.agents)[number];

export function certificationEntry(id: string): CertificationEntry | undefined {
  return CERTIFICATION_MATRIX.agents.find((entry) => entry.id === id);
}

/**
 * The paid Supported promise is derived from certification, never merely copied
 * from a profile. A suspended/missing entry, wrong adapter mode, stale pin, or
 * missing required runtime capability is downgraded to Beta in the picker.
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
      supportTier: "beta",
      certification: "adapter-tested",
      notes: `${runtime.notes ? `${runtime.notes} ` : ""}This configured path is not the release-certified execution mode.`,
    };
  }
  return { ...runtime, certification: "release-tested", testedVersion: entry.pinnedVersion };
}
