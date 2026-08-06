// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { randomBytes } from "node:crypto";
import {
  FRAME_CHUNK_BYTES,
  MAX_REASSEMBLY_BYTES,
  MAX_FRAME_CHUNKS,
  MAX_REASSEMBLY_GROUPS,
} from "./wire-format.js";

// Re-exported so existing importers keep using `./relay-chunk.js`; the value
// itself is owned by the shared wire-format spec.
export { FRAME_CHUNK_BYTES };

/**
 * Relay frame chunking.
 *
 * The relay caps each WebSocket message at RELAY_MAX_FRAME_BYTES (256 KiB by
 * default) and closes any socket that exceeds it. A single agent event can be
 * much larger than that — a big file read, a long diff, a multi-image
 * attachment — so without chunking those events would either be dropped or kill
 * the relay connection (the node flapping "offline" mid-session).
 *
 * The fix splits the *sealed* (already-encrypted) payload string into ordered
 * slices, each sent as its own `t: "frame"` message carrying chunk metadata
 * (`fc` group id, `fi` index, `fn` total). The relay forwards these verbatim —
 * it still only ever reads the `t` field, so the E2E privacy invariant holds and
 * the relay needs no changes. The receiver buffers slices by group id and
 * concatenates them back into the original payload before decrypting.
 *
 * Small frames (the overwhelming majority) are sent unchanged as `{ t, p }` with
 * no chunk fields, so this is fully backward compatible on the wire.
 */

// FRAME_CHUNK_BYTES and the reassembly safety caps now live in the shared
// wire-format spec (imported above) so the node and browser chunkers cannot
// drift.

export interface FrameEnvelope {
  p?: unknown;
  fc?: unknown;
  fi?: unknown;
  fn?: unknown;
}

/**
 * Turn a sealed payload string into one or more wire messages (JSON strings).
 * Returns a single `{ t: "frame", p }` for small payloads, or an ordered list of
 * chunk messages for large ones.
 */
export function frameMessages(payload: string): string[] {
  if (payload.length <= FRAME_CHUNK_BYTES) {
    return [JSON.stringify({ t: "frame", p: payload })];
  }
  const id = randomBytes(8).toString("hex");
  const total = Math.ceil(payload.length / FRAME_CHUNK_BYTES);
  const out: string[] = [];
  for (let i = 0; i < total; i++) {
    const slice = payload.slice(i * FRAME_CHUNK_BYTES, (i + 1) * FRAME_CHUNK_BYTES);
    out.push(JSON.stringify({ t: "frame", p: slice, fc: id, fi: i, fn: total }));
  }
  return out;
}

/**
 * Buffers inbound frame chunks and yields the full payload once a group is
 * complete. A non-chunked frame passes straight through.
 */
export class FrameReassembler {
  private readonly groups = new Map<string, { total: number; parts: (string | undefined)[]; have: number; bytes: number }>();

  /**
   * Feed one inbound frame envelope. Returns the reassembled payload string when
   * complete (or the payload itself when the frame was not chunked), or null
   * while more chunks are still outstanding / the frame was invalid.
   */
  accept(env: FrameEnvelope): string | null {
    if (typeof env.p !== "string") return null;
    if (env.fc === undefined) return env.p; // not chunked

    const id = String(env.fc);
    const index = Number(env.fi);
    const total = Number(env.fn);
    if (!Number.isInteger(index) || !Number.isInteger(total) || total <= 0 || total > MAX_FRAME_CHUNKS || index < 0 || index >= total) {
      return null;
    }

    let group = this.groups.get(id);
    if (!group) {
      // Bound concurrent groups; evict the oldest (insertion order) if needed.
      if (this.groups.size >= MAX_REASSEMBLY_GROUPS) {
        const oldest = this.groups.keys().next().value;
        if (oldest !== undefined) this.groups.delete(oldest);
      }
      group = { total, parts: new Array(total), have: 0, bytes: 0 };
      this.groups.set(id, group);
    }
    if (group.parts[index] !== undefined) return null; // duplicate chunk
    group.parts[index] = env.p;
    group.have += 1;
    group.bytes += env.p.length;
    if (group.bytes > MAX_REASSEMBLY_BYTES) {
      this.groups.delete(id);
      return null;
    }
    if (group.have < group.total) return null;

    this.groups.delete(id);
    return group.parts.join("");
  }
}
