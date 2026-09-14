// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentRuntime, RuntimeMessage } from "../runtime/types.js";
import type { SnapshotSessionInfo } from "./snapshot.js";
import { buildForkHistory, normalizeMessages } from "./transcript-normal.js";

/** An EventLog is a display mirror, not an agent's native conversation store.
 * Reconstruct through the existing runtime-neutral history-import capability.
 * Never call a missing native file a successful resume or silently start empty.
 * This is portable replay, not byte-identical native runtime restoration. */
export async function rebuildSnapshotRuntime(
  info: SnapshotSessionInfo,
  runtime: AgentRuntime,
  messages: RuntimeMessage[],
  workspace: string,
): Promise<string> {
  if (runtime.id !== info.runtimeId) throw new Error("Snapshot runtime identity mismatch");
  if (!runtime.capabilities.forkHistoryImport || !runtime.importHistoryForFork) {
    throw new Error("This runtime cannot replay snapshot history; the stored transcript is retained");
  }
  const history = buildForkHistory(normalizeMessages(messages, {
    sourceRuntimeId: info.runtimeId, title: info.name, createdAt: new Date().toISOString(),
  }));
  if (!history.length) throw new Error("Snapshot contains no replayable conversation");
  const imported = await runtime.importHistoryForFork(history, { workspace, cwd: workspace, model: info.model });
  if (!imported?.sessionFile?.trim()) throw new Error("Snapshot history import returned no resume reference");
  return imported.sessionFile;
}
