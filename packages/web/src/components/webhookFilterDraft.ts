// SPDX-License-Identifier: AGPL-3.0-only
import { parseAutomationFilter, type AutomationFilter } from "@bivy/core";

/** Editable form of an AutomationFilter; the command is one argv string. */
export interface WebhookFilterDraft {
  enabled: boolean;
  command: string;
  cwd: string;
  timeoutSeconds: string;
}

export function filterDraftFrom(filter?: AutomationFilter): WebhookFilterDraft {
  return filter
    ? { enabled: true, command: formatArgv(filter.command), cwd: filter.cwd, timeoutSeconds: String(filter.timeoutSeconds) }
    : { enabled: false, command: "", cwd: "", timeoutSeconds: "5" };
}

/** Disabled drafts yield no filter; invalid enabled drafts yield an error, never a partial filter. */
export function buildWebhookFilter(draft: WebhookFilterDraft): { filter?: AutomationFilter; error?: string } {
  if (!draft.enabled) return {};
  const command = parseArgv(draft.command);
  if (command === null) return { error: "Close the quote in the filter command." };
  if (!command.length) return { error: "Enter the filter command." };
  const cwd = draft.cwd.trim();
  if (!/^(\/|[A-Za-z]:[\\/])/.test(cwd)) return { error: "The filter directory must be an absolute path on the machine." };
  const timeout = Number(draft.timeoutSeconds.trim() || "5");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60) return { error: "The filter timeout must be a whole number from 1 to 60 seconds." };
  try {
    return { filter: parseAutomationFilter({ command, cwd, timeoutSeconds: timeout }) };
  } catch (error) {
    return { error: String((error as Error).message || error) };
  }
}

/** Splits on whitespace, honouring '…' and "…" quoting. No expansion: argv is executed directly. Returns null for an unclosed quote. */
export function parseArgv(text: string): string[] | null {
  const args: string[] = [];
  let current = "";
  let inArg = false;
  let quote: "'" | "\"" | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === "\"") {
      quote = ch;
      inArg = true;
    } else if (/\s/.test(ch)) {
      if (inArg) args.push(current);
      current = "";
      inArg = false;
    } else {
      current += ch;
      inArg = true;
    }
  }
  if (quote) return null;
  if (inArg) args.push(current);
  return args;
}

export function formatArgv(argv: string[]): string {
  return argv.map((arg) => arg && !/[\s'"]/.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`).join(" ");
}
