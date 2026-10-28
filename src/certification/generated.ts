// SPDX-License-Identifier: MIT
// Generated from certification/agents.json by scripts/certification.mjs. Do not edit.
export const CERTIFICATION_MATRIX = {
  schemaVersion: 1,
  agents: [
    { id: "claude-code-sdk", status: "active", executionMode: "protocol", pinnedVersion: "0.3.312", capabilities: ["toolInterception","modelSelection","resume"] },
    { id: "codex-approvals", status: "active", executionMode: "protocol", pinnedVersion: "0.165.0", capabilities: ["toolInterception","modelSelection","resume"] },
    { id: "pi", status: "active", executionMode: "protocol", pinnedVersion: "1.4.0", capabilities: ["toolInterception","modelSelection","resume"] },
    { id: "opencode", status: "active", executionMode: "protocol", pinnedVersion: "1.19.5", capabilities: ["toolInterception","modelSelection","resume"] },
    { id: "grok", status: "active", executionMode: "protocol", pinnedVersion: "1.0.70", capabilities: ["toolInterception","modelSelection","resume"] },
  ]
} as const;
