// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Relay sharding (docs/scaling.md).
 *
 * The relay is a single Node process with in-memory room state, so it routes on
 * ONE core. To use more cores (and more boxes) we run N identical relay
 * processes and deterministically map each node — and all of its clients — to
 * the SAME shard, so a node and its phone always share a room. No shared
 * backplane (Redis) is needed: each shard owns a disjoint slice of nodeIds.
 *
 * The control plane is the only component that decides shard placement: when it
 * mints a relay ticket it returns the shard URL for the ticket's nodeId, and the
 * node/client connect to whatever URL they're handed. That keeps sharding policy
 * in one place and makes resharding (changing the URL set) a pure config change.
 */

/**
 * Parse the shard URL set from the environment.
 *
 * - `RELAY_SHARD_URLS`: comma-separated relay base URLs, one per shard, e.g.
 *   "wss://relay-0.bivy.sh,wss://relay-1.bivy.sh".
 * - Falls back to the single `RELAY_PUBLIC_URL` (one shard) when unset, so the
 *   default deployment is unchanged and sharding is strictly opt-in.
 *
 * Trailing slashes are stripped and empty entries dropped so the result is
 * always a non-empty list of clean base URLs.
 */
export function parseShardUrls(env: NodeJS.ProcessEnv): string[] {
  const raw = env.RELAY_SHARD_URLS?.trim();
  const source = raw && raw.length > 0 ? raw : (env.RELAY_PUBLIC_URL ?? "ws://localhost:4500");
  const urls = source
    .split(",")
    .map((u) => u.trim().replace(/\/$/, ""))
    .filter((u) => u.length > 0);
  // Never return an empty set — callers depend on shardForNode always resolving.
  return urls.length > 0 ? urls : ["ws://localhost:4500"];
}

/**
 * Deterministic 32-bit FNV-1a hash of a string. Stable across processes and
 * restarts (unlike a salted hash), which is exactly what we need: every control
 * plane instance must map a given nodeId to the same shard.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619, kept in 32-bit unsigned range via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Resolve the relay base URL for a node. All of a node's connections (the node
 * itself and every client targeting it) must call this with the same nodeId so
 * they land on the same shard.
 *
 * `nodeId` may be null/undefined only in degenerate cases (e.g. an account-wide
 * client ticket with no target node); we route those to shard 0 deterministically
 * so the call never fails. With a single shard this is always the one URL.
 */
export function shardForNode(nodeId: string | null | undefined, urls: string[]): string {
  if (urls.length === 1) return urls[0];
  if (!nodeId) return urls[0];
  return urls[fnv1a(nodeId) % urls.length];
}
