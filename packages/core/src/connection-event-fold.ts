// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

export interface ConnectionEventData {
  type?: unknown;
  name?: unknown;
  current?: unknown;
  latest?: unknown;
  ok?: unknown;
  error?: unknown;
}

export interface ConnectionFoldValue {
  readonly nodes: readonly { id: string; name?: string }[];
  readonly currentNodeId: string | null;
  readonly nodeUpdate: { current: string; latest: string } | null;
  readonly nodeUpdating: boolean;
}

export interface ConnectionFoldResult<T> {
  handled: boolean;
  value: T;
  error?: string;
}

/** Pure projection of node identity/update events into the connection value. */
export function foldConnectionEvent<T extends ConnectionFoldValue>(
  value: T,
  event: ConnectionEventData,
): ConnectionFoldResult<T> {
  if (event.type === "node.updated") {
    if (typeof event.name !== "string" || !event.name || !value.currentNodeId) return { handled: true, value };
    return {
      handled: true,
      value: {
        ...value,
        nodes: value.nodes.map((node) => node.id === value.currentNodeId ? { ...node, name: event.name as string } : node),
      },
    };
  }
  if (event.type === "node.update") {
    const current = typeof event.current === "string" ? event.current : "";
    const latest = typeof event.latest === "string" ? event.latest : "";
    return {
      handled: true,
      value: current && latest
        ? { ...value, nodeUpdate: { current, latest } }
        : { ...value, nodeUpdate: null, nodeUpdating: false },
    };
  }
  if (event.type === "node.update.result") {
    if (event.ok !== false) {
      // The reply only confirms that the updater was started. The node.update
      // event sent by the replacement process will clear the banner once the
      // new version is actually running, but don't leave the button permanently
      // disabled if the updater exits without restarting the service.
      return { handled: true, value: { ...value, nodeUpdating: false } };
    }
    return {
      handled: true,
      value: { ...value, nodeUpdating: false },
      error: typeof event.error === "string" ? event.error : "Couldn't start the update on this node.",
    };
  }
  return { handled: false, value };
}
