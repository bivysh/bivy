// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Node audit trail — the governance record. One append-only
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
//
// TAMPER-EVIDENCE: when built with a signer, every appended line is
// hash-chained and signed (see ./integrity.ts), so truncation, reordering, and
// edits become detectable via `verifyAuditChain`. The chain is stamped as extra
// fields (`seq`/`prev`/`hash`/`sig`), which readers below ignore, so it is fully
// backward-compatible with pre-chain audit files.
import fs from "node:fs";
import path from "node:path";
import { type AuditSigner, type ChainState, chainEntry, readChainState } from "./integrity.js";

/** A single governance event. `ts` is stamped by the writer. */
export interface AuditEvent {
  ts: number;
  /** Dotted event kind: "tool.call" | "net.attempt" | "approval.request"
   *  | "approval.decision" | "file.change" | "cost" | … */
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
  /** Changed file path — file.change (the DESTINATION, like host for a net
   *  attempt; the file's content/diff text is NEVER recorded). */
  path?: string;
  /** File-change kind — file.change ("added" | "modified" | "deleted"). */
  op?: string;
  /** Per-file line counts from `git diff --numstat` — file.change (counts only,
   *  never the lines themselves). */
  added?: number;
  removed?: number;
  /** Rolling cost/token totals for the session — cost (display-grade metadata,
   *  never used for enforcement). */
  costUsd?: number;
  tokens?: number;
  /** Bounded, non-secret metadata for this kind (never payloads). */
  [field: string]: unknown;
}

export interface AuditLog {
  /** Append one event (ts stamped here). Best-effort — never throws, so an
   *  unwritable audit dir degrades observability but never breaks the daemon. */
  record(event: Omit<AuditEvent, "ts">): void;
  /** Current persistence health. Counts only; never returns audit content. */
  health(): AuditHealth;
  /** Absolute path of the JSONL file, for `bivy audit` / export tooling. */
  readonly file: string;
}

export interface AuditHealth {
  storage: "healthy" | "missing" | "corrupt" | "unreadable";
  writes: "healthy" | "unknown" | "degraded";
  successfulWrites: number;
  failedWrites: number;
  corruptLines: number;
}

export interface CreateAuditLogOptions {
  /** When present, hash-chain and sign every entry so the trail is tamper-evident
   *  (the daemon passes the node's Ed25519 audit key; omit for a plain trail). */
  signer?: AuditSigner;
}

/** Build the node's audit log under `<dir>/audit.jsonl` (dir created lazily). */
export function createAuditLog(dir: string, opts: CreateAuditLogOptions = {}): AuditLog {
  const file = path.join(dir, "audit.jsonl");
  let ensured = false;
  let successfulWrites = 0;
  let failedWrites = 0;
  let cachedSignature = "";
  let cachedStorage: AuditHealth["storage"] = "missing";
  let cachedCorruptLines = 0;
  // Resume the hash chain from the file's tail so a daemon restart continues it
  // rather than forking a fresh chain (which would read as a truncation).
  const chain: ChainState = readChainState(file);
  return {
    file,
    record(event) {
      try {
        if (!ensured) {
          fs.mkdirSync(dir, { recursive: true });
          ensured = true;
        }
        const line = chainEntry(chain, { ts: Date.now(), ...event }, opts.signer);
        fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
        successfulWrites += 1;
        cachedSignature = "";
      } catch {
        failedWrites += 1;
        /* best-effort: audit failure must never break a session */
      }
    },
    health() {
      let storage: AuditHealth["storage"] = "missing";
      let corruptLines = 0;
      try {
        const stat = fs.statSync(file);
        const signature = `${stat.mtimeMs}:${stat.size}`;
        if (signature === cachedSignature) {
          storage = cachedStorage;
          corruptLines = cachedCorruptLines;
        } else {
          const raw = fs.readFileSync(file, "utf8");
          storage = "healthy";
          for (const line of raw.split("\n")) {
            if (!line.trim()) continue;
            try { JSON.parse(line); } catch { corruptLines += 1; }
          }
          if (corruptLines) storage = "corrupt";
          cachedSignature = signature;
          cachedStorage = storage;
          cachedCorruptLines = corruptLines;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") storage = "unreadable";
      }
      return {
        storage,
        writes: failedWrites ? "degraded" : successfulWrites ? "healthy" : "unknown",
        successfulWrites,
        failedWrites,
        corruptLines,
      };
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
