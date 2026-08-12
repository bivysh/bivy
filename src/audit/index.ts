// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Node audit trail — the governance record (moat work #1). One append-only
// JSONL stream of GOVERNANCE events (tool-call decisions, network attempts,
// approvals, …) that Bivy already intercepts at the substrate, attributed per
// session + agent, uniformly across every agent. This is distinct from the
// per-session transcript (`session/event-log.ts`, which is UI history): the
// audit trail answers "what did agents do on this node, and did Bivy allow it",
// and is queryable/exportable via `bivy audit`.
//
// REDACTION IS THE CALLER'S CONTRACT: this writer records exactly the fields it
// is handed, so callers pass DECISIONS + bounded METADATA (tool name, allow/deny,
// host:port) and NEVER payloads (tool args/results, request bodies, source).
// Payload capture stays opt-in and separate (see runtime/tool-trace.ts).
//
// Pure fs leaf: imports nothing from the kernel; the daemon constructs one
// AuditLog and hands `record` to the guardian / egress / approval seams.
import fs from "node:fs";
import path from "node:path";

/** A single governance event. `ts` is stamped by the writer. */
export interface AuditEvent {
  ts: number;
  /** Dotted event kind: "tool.call" | "net.attempt" | "approval.request"
   *  | "approval.decision" | … */
  kind: string;
  /** The session the action belongs to, when known. */
  session?: string;
  /** The agent/runtime id that produced it (agent-agnostic attribution). */
  agent?: string;
  /** Allow/deny the node made ("allowed" | "blocked") — tool.call / net.attempt. */
  decision?: string;
  /** Human-readable reason for a block/deny (never a payload). */
  reason?: string;
  /** Tool name — tool.call / approval.{request,decision} (never its args). */
  tool?: string;
  /** Egress destination — net.attempt (host + port only, never bytes). */
  host?: string;
  port?: number;
  /** Approval correlation id, tying an approval.decision to its request. */
  requestId?: string;
  /** Whether a human approval was granted — approval.decision. */
  approved?: boolean;
  /** Bounded, non-secret metadata for this kind (never payloads). */
  [field: string]: unknown;
}

export interface AuditLog {
  /** Append one event (ts stamped here). Best-effort — never throws, so an
   *  unwritable audit dir degrades observability but never breaks the daemon. */
  record(event: Omit<AuditEvent, "ts">): void;
  /** Absolute path of the JSONL file, for `bivy audit` / export tooling. */
  readonly file: string;
}

/** Build the node's audit log under `<dir>/audit.jsonl` (dir created lazily). */
export function createAuditLog(dir: string): AuditLog {
  const file = path.join(dir, "audit.jsonl");
  let ensured = false;
  return {
    file,
    record(event) {
      try {
        if (!ensured) {
          fs.mkdirSync(dir, { recursive: true });
          ensured = true;
        }
        fs.appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...event })}\n`);
      } catch {
        /* best-effort: audit failure must never break a session */
      }
    },
  };
}

export interface ReadAuditOptions {
  /** Only events for this session. */
  session?: string;
  /** Only events of this kind. */
  kind?: string;
  /** Return at most the most-recent N (after filtering). */
  limit?: number;
}

/** Read + filter the audit trail. Malformed lines are skipped, not thrown. */
export function readAuditEvents(file: string, opts: ReadAuditOptions = {}): AuditEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: AuditEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: AuditEvent;
    try {
      event = JSON.parse(trimmed) as AuditEvent;
    } catch {
      continue;
    }
    if (opts.session && event.session !== opts.session) continue;
    if (opts.kind && event.kind !== opts.kind) continue;
    out.push(event);
  }
  return opts.limit && opts.limit > 0 ? out.slice(-opts.limit) : out;
}
