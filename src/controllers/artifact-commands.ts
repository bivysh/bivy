// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// The machine-wide Artifacts index behind the sidebar's Artifacts page: every
// file an agent sent into a chat (`bivy attach` / `attach_to_chat`), across all
// of this machine's sessions. Built from the same event-log records attachment
// GC already sweeps, so there is no second index to keep in sync. Only what can
// still be opened is listed: the session exists and the blob is still stored.

import type { CommandEntries } from "../protocol/command-registry.js";
import type { LogRecord } from "../session/event-log.js";

export interface MachineArtifact {
  sessionId: string;
  hash: string;
  name: string;
  mimeType: string;
  kind: "image" | "file";
  size: number;
  caption?: string;
  createdAt: number;
  artifact: boolean;
}

export interface ArtifactIndexDeps {
  sessionIds: () => Iterable<string>;
  /** A session's outbound-attachment records, read without caching the log. */
  scan: (sessionId: string) => readonly LogRecord[];
  /** Whether the blob is still in the attachment store (GC may have pruned it). */
  stored: (hash: string) => boolean;
}

/** Newest first, bounded like the per-session projection. */
export const MAX_MACHINE_ARTIFACTS = 500;

/** One entry per content hash — the newest send wins, so the same report sent
 * to two sessions links to where it was sent last. */
export function listMachineArtifacts(deps: ArtifactIndexDeps): MachineArtifact[] {
  const byHash = new Map<string, MachineArtifact>();
  for (const sessionId of deps.sessionIds()) {
    for (const record of deps.scan(sessionId)) {
      if (record.bivyKind !== "outbound-attachment") continue;
      const { ref } = record;
      const existing = byHash.get(ref.hash);
      if (existing && existing.createdAt >= record.createdAt) continue;
      byHash.set(ref.hash, {
        sessionId, hash: ref.hash, name: ref.name, mimeType: ref.mimeType, kind: ref.kind, size: ref.size,
        ...(record.caption ? { caption: record.caption } : {}),
        createdAt: record.createdAt,
        artifact: Boolean(record.artifact || existing?.artifact),
      });
    }
  }
  return [...byHash.values()]
    .filter((item) => deps.stored(item.hash))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_MACHINE_ARTIFACTS);
}

interface ArtifactCommand { kind: string; requestId?: unknown; [key: string]: unknown }
export function createArtifactCommands(deps: ArtifactIndexDeps): CommandEntries<ArtifactCommand> {
  return {
    "artifacts.list"(msg, ctx) {
      ctx.reply({ type: "artifacts.list.ok", requestId: msg.requestId, artifacts: listMachineArtifacts(deps) });
    },
  };
}
