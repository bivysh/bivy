// SPDX-License-Identifier: AGPL-3.0-only

import type { AccountAutomation } from "@bivy/core";

/**
 * The Automations overview is for durable definitions. One-time schedules are
 * transient work (including scheduled follow-up delivery) and belong in Runs,
 * not in the user's persistent automation list.
 */
export function isListedAutomation(item: Pick<AccountAutomation, "schedule">): boolean {
  return item.schedule.kind !== "once";
}
