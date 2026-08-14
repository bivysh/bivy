// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Relay frame chunking. The relay caps each message at ~256 KiB, so large sealed
// payloads (e.g. image attachments) are split into ordered slices the peer
// reassembles before decrypting. Must mirror src/relay-chunk.ts on the node.
// Ported from public/app/relay-frame.js.

import {
  FRAME_CHUNK_BYTES as SHARED_FRAME_CHUNK_BYTES,
  MAX_REASSEMBLY_BYTES,
  MAX_FRAME_CHUNKS,
  MAX_REASSEMBLY_GROUPS,
} from "./wire-format.js";

// Owned by the shared wire-format spec; re-exported so existing importers keep
// using `./relay-frame.js`.
export const FRAME_CHUNK_BYTES = SHARED_FRAME_CHUNK_BYTES;

export interface FrameEnvelope {
  t?: string;
  p?: string;
  /** chunk group id */
  fc?: string;
  /** chunk index */
  fi?: number;
  /** chunk count */
  fn?: number;
}

export function frameMessages(payload: string, nonceFactory?: () => string): string[] {
  const p = String(payload || "");
  if (p.length <= FRAME_CHUNK_BYTES) return [JSON.stringify({ t: "frame", p })];
  const id = nonceFactory ? nonceFactory() : `${Date.now()}-${Math.random()}`;
  const total = Math.ceil(p.length / FRAME_CHUNK_BYTES);
  const out: string[] = [];
  for (let i = 0; i < total; i++) {
    out.push(
      JSON.stringify({ t: "frame", p: p.slice(i * FRAME_CHUNK_BYTES, (i + 1) * FRAME_CHUNK_BYTES), fc: id, fi: i, fn: total }),
    );
  }
  return out;
}

export interface ReassemblerOptions {
  maxGroups?: number;
  maxBytes?: number;
}

interface Group {
  total: number;
  parts: (string | undefined)[];
  have: number;
  bytes: number;
}

/** Returns the reassembled payload string, or null while a group is incomplete/invalid. */
export function createFrameReassembler(opts?: ReassemblerOptions): (env: FrameEnvelope) => string | null {
  const groups = new Map<string, Group>();
  const maxGroups = opts?.maxGroups || MAX_REASSEMBLY_GROUPS;
  const maxBytes = opts?.maxBytes || MAX_REASSEMBLY_BYTES;
  return function reassembleFrame(env: FrameEnvelope): string | null {
    if (!env || typeof env !== "object") return null;
    if (env.fc === undefined) return env.p ?? null;
    const id = String(env.fc);
    const i = Number(env.fi);
    const n = Number(env.fn);
    if (!Number.isInteger(i) || !Number.isInteger(n) || n <= 0 || n > MAX_FRAME_CHUNKS || i < 0 || i >= n) return null;
    let g = groups.get(id);
    if (!g) {
      if (groups.size >= maxGroups) {
        const oldest = groups.keys().next().value;
        if (oldest !== undefined) groups.delete(oldest);
      }
      g = { total: n, parts: new Array(n), have: 0, bytes: 0 };
      groups.set(id, g);
    }
    if (g.parts[i] !== undefined) return null;
    const part = String(env.p || "");
    g.parts[i] = part;
    g.have++;
    g.bytes += part.length;
    if (g.bytes > maxBytes) {
      groups.delete(id);
      return null;
    }
    if (g.have < g.total) return null;
    groups.delete(id);
    return g.parts.join("");
  };
}
