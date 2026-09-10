// SPDX-License-Identifier: AGPL-3.0-only
// Wire format mirrored in src/automation-template.ts (node has no core dependency).
const PREFIX = "bivy-automation-v1\n";
export interface AutomationTemplate {
  instructions: string;
  credentialLabels: Record<string, string>;
}

/** Account labels, never credentials, travel inside the encrypted template. */
export function encodeAutomationTemplate(instructions: string, credentialLabels: Record<string, string>): string {
  return Object.keys(credentialLabels).length || instructions.startsWith(PREFIX)
    ? PREFIX + JSON.stringify({ instructions, credentialLabels })
    : instructions;
}

/** Legacy plaintext templates remain valid. Malformed structured templates fail closed. */
export function decodeAutomationTemplate(value: string): AutomationTemplate {
  if (!value.startsWith(PREFIX)) return { instructions: value, credentialLabels: {} };
  const data = JSON.parse(value.slice(PREFIX.length));
  if (!data || typeof data.instructions !== "string" || !data.credentialLabels ||
      typeof data.credentialLabels !== "object" || Array.isArray(data.credentialLabels) ||
      Object.entries(data.credentialLabels).some(([provider, label]) =>
        !provider.trim() || provider !== provider.trim().toLowerCase() || typeof label !== "string" || !label.trim())) {
    throw new Error("Invalid automation account selections");
  }
  return { instructions: data.instructions, credentialLabels: data.credentialLabels };
}
