// SPDX-License-Identifier: AGPL-3.0-only
import { AutomationFilterError, runAutomationFilter, webhookFilterInput } from "./automation-filter.js";
import type { AutomationFilter } from "./automation-template.js";
import type { EvidencePatch } from "./control-plane-tasks.js";

/** Returns false for an intentional skip; failures park the run, never start an agent. */
export async function passWebhookFilter(
  filter: AutomationFilter,
  item: { id: string; eventContext?: string },
  report: (patch: EvidencePatch) => Promise<void>,
  signal: AbortSignal,
): Promise<boolean> {
  let result;
  try {
    let payload: unknown;
    try { payload = JSON.parse(item.eventContext ?? ""); }
    catch { throw new AutomationFilterError("Webhook filter requires structured event context; manual runs without a payload are not supported"); }
    result = await runAutomationFilter(filter, webhookFilterInput(payload, item.id), signal);
  } catch (error) {
    const failure = error instanceof AutomationFilterError ? error : new AutomationFilterError("Invalid webhook filter configuration");
    // Raw stderr stays on the node, not in control-plane evidence.
    if (failure.diagnostics) console.warn(`[automation-filter:${item.id}] ${failure.diagnostics}`);
    throw failure;
  }
  if (result.diagnostics) console.warn(`[automation-filter:${item.id}] ${result.diagnostics}`);
  await report({
    checks: [{ name: "webhook-filter", status: result.decision === "accept" ? "passed" : "skipped" }],
    events: [{ at: new Date().toISOString(), kind: "checkpoint",
      summary: `Webhook filter ${result.decision === "accept" ? "accepted" : "skipped"} delivery${result.reason ? `: ${result.reason}` : "."}`,
    }],
  });
  return result.decision === "accept";
}
