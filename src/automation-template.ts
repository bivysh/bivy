// SPDX-License-Identifier: AGPL-3.0-only
// Wire format mirrored in src/automation-template.ts (node has no core dependency).
const PREFIX = "bivy-automation-v1\n";
export interface AutomationFilter {
  command: string[];
  /** Operator-controlled directory on the assigned node, never an event checkout. */
  cwd: string;
  timeoutSeconds: number;
}

export function parseAutomationFilter(value: unknown): AutomationFilter {
  const o = value as Partial<AutomationFilter> | null;
  if (!o || typeof o !== "object" || Array.isArray(o) ||
      Object.keys(o).some(key => !["command", "cwd", "timeoutSeconds"].includes(key)) ||
      !Array.isArray(o.command) || !o.command.length || o.command.length > 64 ||
      o.command.some(arg => typeof arg !== "string" || arg.length > 4096 || arg.includes("\u0000")) ||
      !o.command[0]?.trim() || typeof o.cwd !== "string" || o.cwd.length > 4096 ||
      o.cwd.includes("\u0000") || !/^(\/|[A-Za-z]:[\\/])/.test(o.cwd) ||
      (o.timeoutSeconds !== undefined && (!Number.isInteger(o.timeoutSeconds) || o.timeoutSeconds < 1 || o.timeoutSeconds > 60))) {
    throw new Error("filter requires command (non-empty argv list), cwd (absolute trusted directory), and optional timeoutSeconds (1-60)");
  }
  return { command: [...o.command], cwd: o.cwd, timeoutSeconds: o.timeoutSeconds ?? 5 };
}

export interface AutomationTemplate {
  instructions: string;
  credentialLabels: Record<string, string>;
  filter?: AutomationFilter;
}

/** Account labels, never credentials, travel inside the encrypted template. */
export function encodeAutomationTemplate(instructions: string, credentialLabels: Record<string, string>, filter?: AutomationFilter): string {
  return filter || Object.keys(credentialLabels).length || instructions.startsWith(PREFIX)
    ? PREFIX + JSON.stringify({ instructions, credentialLabels, ...(filter ? { filter: parseAutomationFilter(filter) } : {}) })
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
  return { instructions: data.instructions, credentialLabels: data.credentialLabels,
    ...(data.filter === undefined ? {} : { filter: parseAutomationFilter(data.filter) }) };
}
