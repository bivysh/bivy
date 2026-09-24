// SPDX-License-Identifier: AGPL-3.0-only
// Generated from certification/agents.json by scripts/certification.mjs. Do not edit.
export const CERTIFICATION_MATRIX = {
  schemaVersion: 1,
  agents: [
    { id: "claude-code-sdk", status: "active", executionMode: "protocol", pinnedVersion: "0.3.281", capabilities: ["toolInterception","modelSelection","resume"] },
    { id: "codex-approvals", status: "active", executionMode: "protocol", pinnedVersion: "0.156.1", capabilities: ["toolInterception","modelSelection","resume"] },
    { id: "pi", status: "active", executionMode: "protocol", pinnedVersion: "0.87.1", capabilities: ["toolInterception","modelSelection","resume"] },
    { id: "opencode", status: "active", executionMode: "protocol", pinnedVersion: "1.18.32", capabilities: ["toolInterception","modelSelection","resume"] },
  ]
} as const;
