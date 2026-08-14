// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad

import { createHash } from "node:crypto";

export const RUN_TOOL_LIMITS = {
  maxInstructions: 16_000,
  maxDepth: 3,
  maxConcurrentChildren: 3,
  maxWaitSeconds: 300,
  minPollMs: 1_000,
  maxIdempotencyKey: 128,
} as const;

export type DelegatedRunStatus = "pending" | "claimed" | "running" | "waiting" | "needs_attention" | "succeeded" | "failed" | "cancelled";
export type RunSafetyInput = { approval?: "never" | "risky" | "always" | "autonomous"; sandbox?: "read-only" | "workspace-write" | "danger-full-access"; maxAttempts?: number };
export type StartRunInput = { instructions: string; repo?: string; machine?: string; agent?: string; model?: string; safety?: RunSafetyInput; idempotencyKey?: string };
export type SafeRunResult = {
  runId: string;
  status: DelegatedRunStatus;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  attempt?: number;
  maxAttempts?: number;
  timedOut?: boolean;
  wait?: { timedOut: boolean; childContinues: boolean };
  provenance: { parentSessionId: string; parentRunId?: string; depth: number };
  references?: { sessionId?: string; branch?: string; prUrl?: string; artifactUrl?: string; failure?: string };
  checks?: Array<{ name: string; status: string; exitCode?: number }>;
};

type RawRun = Record<string, unknown> & { id?: unknown; status?: unknown; source?: unknown; output?: unknown; checks?: unknown };
type ParentContext = { parentRunId?: string; depth?: number };
export interface RunDelegationBackend {
  parentContext(sessionId: string): ParentContext | undefined;
  start(sessionId: string, input: StartRunInput, provenance: SafeRunResult["provenance"]): Promise<RawRun>;
  get(runId: string): Promise<RawRun | undefined>;
  listRecent(): Promise<RawRun[]>;
}

const TERMINAL = new Set<DelegatedRunStatus>(["succeeded", "failed", "cancelled"]);
const STATUSES = new Set<DelegatedRunStatus>(["pending", "claimed", "running", "waiting", "needs_attention", "succeeded", "failed", "cancelled"]);
const SOURCE_PREFIX = "agent-delegation:v1:";
const bounded = (v: unknown, n: number): string | undefined => typeof v === "string" && v ? v.slice(0, n) : undefined;

function idempotencyDigest(key?: string): string | undefined { return key ? createHash("sha256").update(key).digest("base64url").slice(0, 22) : undefined; }
export function delegationSource(parentSessionId: string, parentRunId: string | undefined, depth: number, idempotencyKey?: string): string {
  const digest = idempotencyDigest(idempotencyKey);
  return `${SOURCE_PREFIX}${depth}:${Buffer.from(parentSessionId).toString("base64url")}:${parentRunId ? Buffer.from(parentRunId).toString("base64url") : "-"}${digest ? `:${digest}` : ""}`;
}
export function parseDelegationSource(source: unknown): SafeRunResult["provenance"] | undefined {
  if (typeof source !== "string" || !source.startsWith(SOURCE_PREFIX)) return undefined;
  const [depthRaw, sessionRaw, runRaw] = source.slice(SOURCE_PREFIX.length).split(":");
  const depth = Number(depthRaw);
  if (!Number.isInteger(depth) || depth < 1 || depth > RUN_TOOL_LIMITS.maxDepth || !sessionRaw) return undefined;
  try {
    const parentSessionId = Buffer.from(sessionRaw, "base64url").toString("utf8");
    const parentRunId = runRaw && runRaw !== "-" ? Buffer.from(runRaw, "base64url").toString("utf8") : undefined;
    if (!parentSessionId || parentSessionId.length > 256 || (parentRunId?.length ?? 0) > 256) return undefined;
    return { parentSessionId, ...(parentRunId ? { parentRunId } : {}), depth };
  } catch { return undefined; }
}

function safeRun(raw: RawRun, provenance: SafeRunResult["provenance"]): SafeRunResult {
  const status = STATUSES.has(raw.status as DelegatedRunStatus) ? raw.status as DelegatedRunStatus : "pending";
  const output = raw.output && typeof raw.output === "object" ? raw.output as Record<string, unknown> : {};
  const references = {
    sessionId: bounded(output.sessionId, 256), branch: bounded(output.branch, 256),
    prUrl: bounded(output.prUrl, 1_024), artifactUrl: bounded(output.artifactUrl, 1_024), failure: bounded(output.failure, 500),
  };
  const checks = Array.isArray(raw.checks) ? raw.checks.slice(0, 50).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const c = item as Record<string, unknown>; const name = bounded(c.name, 120); const state = bounded(c.status, 40);
    return name && state ? [{ name, status: state, ...(Number.isInteger(c.exitCode) ? { exitCode: Number(c.exitCode) } : {}) }] : [];
  }) : undefined;
  return {
    runId: bounded(raw.id, 256) ?? "unknown", status,
    createdAt: bounded(raw.createdAt, 64), startedAt: bounded(raw.startedAt, 64), completedAt: bounded(raw.completedAt, 64),
    attempt: Number.isInteger(raw.attempt) ? Number(raw.attempt) : undefined,
    maxAttempts: Number.isInteger(raw.maxAttempts) ? Number(raw.maxAttempts) : undefined,
    provenance,
    ...(Object.values(references).some(Boolean) ? { references } : {}),
    ...(checks?.length ? { checks } : {}),
  };
}

function validateStart(input: StartRunInput): void {
  if (!input || typeof input !== "object") throw new Error("input is required");
  if (typeof input.instructions !== "string" || !input.instructions.trim()) throw new Error("instructions are required");
  if (input.instructions.length > RUN_TOOL_LIMITS.maxInstructions) throw new Error(`instructions must be at most ${RUN_TOOL_LIMITS.maxInstructions} characters`);
  for (const [key, value, max] of [["repo", input.repo, 200], ["machine", input.machine, 120], ["agent", input.agent, 120], ["model", input.model, 200], ["idempotencyKey", input.idempotencyKey, RUN_TOOL_LIMITS.maxIdempotencyKey]] as const) {
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > max)) throw new Error(`${key} must be a non-empty string of at most ${max} characters`);
  }
  if (input.safety?.maxAttempts !== undefined && (!Number.isInteger(input.safety.maxAttempts) || input.safety.maxAttempts < 1 || input.safety.maxAttempts > 10)) throw new Error("safety.maxAttempts must be an integer from 1 to 10");
}

export class RunDelegationService {
  private readonly cache = new Map<string, { at: number; value: SafeRunResult }>();
  private readonly startLocks = new Map<string, Promise<void>>();
  constructor(private readonly backend: RunDelegationBackend, private readonly now = () => Date.now(), private readonly sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("wait cancelled; the child Run may still be running")); }, { once: true });
  })) {}

  private context(sessionId: string): SafeRunResult["provenance"] {
    const parent = this.backend.parentContext(sessionId);
    if (!parent) throw new Error("calling Session is not available");
    const depth = (parent.depth ?? 0) + 1;
    if (depth > RUN_TOOL_LIMITS.maxDepth) throw new Error(`delegation depth limit (${RUN_TOOL_LIMITS.maxDepth}) reached`);
    return { parentSessionId: sessionId, ...(parent.parentRunId ? { parentRunId: parent.parentRunId } : {}), depth };
  }
  private async authorized(sessionId: string, runId: string, force = false): Promise<SafeRunResult> {
    const cached = this.cache.get(`${sessionId}:${runId}`);
    if (!force && cached && this.now() - cached.at < RUN_TOOL_LIMITS.minPollMs) return cached.value;
    const raw = await this.backend.get(runId);
    const provenance = raw ? parseDelegationSource(raw.source) : undefined;
    if (!raw || provenance?.parentSessionId !== sessionId) throw new Error("delegated Run not found");
    const value = safeRun(raw, provenance);
    this.cache.set(`${sessionId}:${runId}`, { at: this.now(), value });
    return value;
  }
  async startRun(sessionId: string, input: StartRunInput): Promise<SafeRunResult> {
    validateStart(input);
    const previous = this.startLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.startLocks.set(sessionId, current);
    await previous;
    try {
      const provenance = this.context(sessionId);
      const recent = await this.backend.listRecent();
      const expectedSource = input.idempotencyKey ? delegationSource(sessionId, provenance.parentRunId, provenance.depth, input.idempotencyKey) : undefined;
      const existing = expectedSource ? recent.find((r) => r.source === expectedSource) : undefined;
      if (existing) return safeRun(existing, provenance);
      const active = recent.filter((r) => parseDelegationSource(r.source)?.parentSessionId === sessionId && !TERMINAL.has(r.status as DelegatedRunStatus)).length;
      if (active >= RUN_TOOL_LIMITS.maxConcurrentChildren) throw new Error(`concurrent child Run limit (${RUN_TOOL_LIMITS.maxConcurrentChildren}) reached`);
      const raw = await this.backend.start(sessionId, input, provenance);
      const value = safeRun(raw, provenance);
      this.cache.set(`${sessionId}:${value.runId}`, { at: this.now(), value });
      return value;
    } finally {
      release();
      if (this.startLocks.get(sessionId) === current) this.startLocks.delete(sessionId);
    }
  }
  getRunStatus(sessionId: string, runId: string): Promise<SafeRunResult> { return this.authorized(sessionId, runId); }
  async waitForRun(sessionId: string, runId: string, timeoutSeconds: number, signal?: AbortSignal): Promise<SafeRunResult> {
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > RUN_TOOL_LIMITS.maxWaitSeconds) throw new Error(`timeoutSeconds must be from 1 to ${RUN_TOOL_LIMITS.maxWaitSeconds}`);
    const deadline = this.now() + timeoutSeconds * 1_000;
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("wait cancelled; the child Run may still be running");
      const result = await this.authorized(sessionId, runId, true);
      if (TERMINAL.has(result.status)) return result;
      if (this.now() >= deadline) return { ...result, timedOut: true, wait: { timedOut: true, childContinues: true } };
      await this.sleep(Math.min(RUN_TOOL_LIMITS.minPollMs, Math.max(1, deadline - this.now())), signal);
    }
  }
}
