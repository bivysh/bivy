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
  if (payload.length > MAX_REASSEMBLY_BYTES) throw new Error("Relay payload exceeds the receiver limit; use a bounded transfer.");
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

export interface ReassemblerOptions {
  maxGroups?: number;
  maxBytes?: number;
  timeoutMs?: number;
  onReject?: (reason: string) => void;
}

interface Group {
  total: number;
  parts: (string | undefined)[];
  have: number;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}

/** null means incomplete or rejected; onReject distinguishes delivery failure.
 * Limits apply to aggregate buffering as well as individual messages. */
export function createFrameReassembler(opts: ReassemblerOptions = {}) {
  const groups = new Map<string, Group>();
  const rejected = new Map<string, number>();
  const maxGroups = opts.maxGroups ?? MAX_REASSEMBLY_GROUPS;
  const maxBytes = opts.maxBytes ?? MAX_REASSEMBLY_BYTES;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let buffered = 0;
  const remove = (id: string) => {
    const group = groups.get(id);
    if (group) { clearTimeout(group.timer); buffered -= group.bytes; groups.delete(id); }
  };
  const reject = (id: string, reason: string) => {
    remove(id);
    if (rejected.size >= 256) rejected.delete(rejected.keys().next().value!);
    rejected.set(id, Date.now() + timeoutMs);
    opts.onReject?.(reason);
    return null;
  };
  const accept = (env: FrameEnvelope): string | null => {
    for (const [id, expires] of rejected) if (expires <= Date.now()) rejected.delete(id);
    if (!env || typeof env.p !== "string") return null;
    if (env.fc === undefined) return env.p.length <= maxBytes ? env.p : reject("unchunked", "Relay response exceeds the receive limit.");
    const id = String(env.fc);
    if (rejected.has(id)) return null;
    const i = Number(env.fi);
    const n = Number(env.fn);
    if (!Number.isInteger(i) || !Number.isInteger(n) || n <= 0 || n > MAX_FRAME_CHUNKS || i < 0 || i >= n) return reject(id, "Invalid relay chunk metadata.");
    let group = groups.get(id);
    if (group && group.total !== n) return reject(id, "Inconsistent relay chunk count.");
    if (!group) {
      if (groups.size >= maxGroups) return reject(id, "Too many incomplete relay responses.");
      const timer = setTimeout(() => reject(id, "Relay response timed out before all chunks arrived."), timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      group = { total: n, parts: new Array(n), have: 0, bytes: 0, timer };
      groups.set(id, group);
    }
    if (group.parts[i] !== undefined) return null;
    if (buffered + env.p.length > maxBytes) return reject(id, "Relay responses exceed the receive memory limit.");
    group.parts[i] = env.p;
    group.have++;
    group.bytes += env.p.length;
    buffered += env.p.length;
    if (group.have < group.total) return null;
    const payload = group.parts.join("");
    remove(id);
    // Ignore straggling duplicates of a completed group instead of creating a
    // new incomplete group that later reports a spurious timeout.
    if (rejected.size >= 256) rejected.delete(rejected.keys().next().value!);
    rejected.set(id, Date.now() + timeoutMs);
    return payload;
  };
  return Object.assign(accept, { reset() { for (const id of groups.keys()) remove(id); rejected.clear(); } });
}

export class FrameReassembler {
  private readonly acceptFrame;
  constructor(options: ReassemblerOptions = {}) { this.acceptFrame = createFrameReassembler(options); }
  accept(env: FrameEnvelope): string | null { return this.acceptFrame(env); }
  reset(): void { this.acceptFrame.reset(); }
}
