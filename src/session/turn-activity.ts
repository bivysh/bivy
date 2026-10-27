// SPDX-License-Identifier: MIT
/** Transient turn activity, not viewer presence. A remote prompt is pending
 * before the runtime emits agent_start, and must settle on every terminal path. */
export interface TurnActivity {
  isWorking?: boolean;
  remoteActive?: boolean;
  lastActivity?: unknown;
  workingStartedAt?: number;
}

export function clearTurnActivity(record: TurnActivity): void {
  record.isWorking = false;
  record.remoteActive = false;
  record.lastActivity = undefined;
  record.workingStartedAt = undefined;
}
