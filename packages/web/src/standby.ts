// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// A session this machine holds only as a warm standby copy (session
// replication tags it `replica:<ownerNodeId>`; see docs/session-replication.md).
// Pure, so the rules are testable without a browser.

export interface StandbyCopy {
  ownerId: string;
  ownerName: string;
  /** The owning machine is reachable, so the session should be opened there. */
  ownerOnline: boolean;
}

export function standbyCopyOf(source: string | undefined, nodes: ReadonlyArray<{ id: string; name?: string; online?: boolean }>): StandbyCopy | undefined {
  if (!source?.startsWith("replica")) return undefined;
  const ownerId = source.slice("replica:".length);
  const owner = ownerId ? nodes.find((node) => node.id === ownerId) : undefined;
  return { ownerId, ownerName: owner?.name || "another machine", ownerOnline: Boolean(owner?.online) };
}
