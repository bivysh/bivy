// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/**
 * Control-plane work-queue poller (E2/E4 node side).
 *
 * The hosted control plane is the inbound front door: a GitHub issue webhook
 * (E2) or a Slack command (E4) enqueues a WORK ITEM there. The node dials
 * outbound only (invariant #4), so the control plane notifies it over the
 * already-open relay socket when possible and it falls back to POLLING the
 * control plane for pending items. It claims one (atomically — only one node
 * wins), runs it on its own machine with its own token, then marks it done.
 * Content never reaches the control plane; only the branch + PR go to GitHub.
 *
 * This complements the legacy direct GitHub polling in github-tasks.ts: that
 * path is for a single self-hosted repo; this path lets the hosted service route
 * issues (and Slack) across many repos/nodes. Pure HTTP + claim/loop logic lives
 * here; the actual run is injected so the daemon keeps the agent wiring.
 */

import { randomUUID } from "node:crypto";
import { WorkResultOutbox, type WorkResult } from "./work-result-outbox.js";
import type { RunDecision, RunPolicy } from "./policy/run-policy.js";
import { RemoteSessionAdmissionError } from "./session/remote-session-admission.js";

export interface ControlPlaneTaskConfig {
  controlPlaneUrl: string;
  enrollmentToken: string;
  labels: string[]; // the labels this node serves, e.g. ["bivy", "bivy/laptop"]
  pollMs: number;
  /** This node's own owner-declared capability tags (node.capabilities in
   * config.yaml), used to gate/rank pending items that request tags. Absent
   * (rather than empty) for callers/tests that don't set it — treated as []. */
  capabilities?: string[];
}

export interface WorkItem {
  claimToken?: string;
  id: string;
  label: string;
  source: string; // "github:issue" | "github:comment" | "linear:issue" | "slack"
  status: string;
  title: string;
  body?: string;
  // Untrusted, plaintext context from a webhook trigger's event payload. The node
  // appends it to the (E2E-decrypted) operator template as data, clearly framed
  // as not-instructions. Only present for webhook-triggered automation runs.
  eventContext?: string;
  repo?: string; // "owner/repo"
  issueNumber?: number;
  externalId?: string; // provider-native id, e.g. Linear issue UUID
  url?: string;
  runtimeId?: string; // agent/runtime override chosen via the queue "Run…" action
  model?: string; // model override chosen via the queue "Run…" action
  approvalMode?: "never" | "risky" | "always" | "autonomous";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Hard ceiling from the automation definition; retry rules cannot exceed it. */
  maxAttempts?: number;
  /** Node-local attempt currently being executed; assigned by the policy loop. */
  attempt?: number;
  installationId?: string; // GitHub App install to mint a token for (flavor A)
  appId?: string; // which configured app that installation belongs to (a node may serve several)
  // Case B: the control plane sets this to "existing_session" + a sessionId when an
  // inbound issue/comment matches an already-indexed session, so the node continues
  // that thread instead of starting fresh (see runWorkItem). Already on the wire
  // (mapWorkItem); typed here so it isn't silently dropped.
  targetKind?: "new_session" | "existing_session";
  targetSessionId?: string;
  message?: boolean;
  leaseExpiresAt?: string;
  /** Capability tags this run needs/prefers on the claiming Machine. See
   * @bivy/core's capability-routing.ts (the canonical matcher; duplicated
   * here in miniature since root src/ has no @bivy/core dependency). */
  requiredCapabilities?: string[];
  preferredCapabilities?: string[];
}

/** True when every required tag is among this node's declared capabilities.
 * A node that fails this must never attempt to claim the item — the hard
 * block happens locally, before any claim race, so an ineligible node never
 * even contends for it. */
export function capabilityEligible(nodeCapabilities: string[], required: string[] | undefined): boolean {
  if (!required || required.length === 0) return true;
  const have = new Set(nodeCapabilities);
  return required.every((tag) => have.has(tag));
}

/** Soft, best-effort delay before this node attempts to claim an item that
 * prefers capability tags it doesn't have — giving a better-matching Machine
 * (shorter/zero delay) first opportunity, without ever refusing to claim it
 * (any node, including a zero-match one, still claims it once the delay
 * elapses — this never fabricates availability). Deterministic: no
 * randomness, so it stays predictable in logs and tests. Mirrors
 * @bivy/core's capabilityClaimDelayMs; duplicated for the same
 * no-cross-package-dependency reason as capabilityEligible above. */
export function capabilityClaimDelayMs(nodeCapabilities: string[], preferred: string[] | undefined, baseMs = 1500, maxMs = 4000): number {
  if (!preferred || preferred.length === 0) return 0;
  const have = new Set(nodeCapabilities);
  const unmatched = preferred.filter((tag) => !have.has(tag)).length;
  return Math.min(maxMs, Math.round(baseMs * (unmatched / preferred.length)));
}

/** Sanitized-on-arrival at the control plane (services/control-plane/src/run-evidence.ts);
 *  the node just needs to shape a plain object — routingReason/output/checks/events. */
export type EvidencePatch = Record<string, unknown>;

/**
 * Build config from the relay enrollment + node label. Returns null if disabled.
 *
 * `nodeName` is the node's own registered name (identity.name). The control plane
 * routes targeted work to `bivy/<name>` — a `bivy/<node>` label, an `@bot on
 * <node>` directive, or the account's default-node setting all resolve to the
 * node's *name*. So the node automatically serves `bivy/<its-name>` without any
 * manual `--node-label`/`BIVY_NODE_LABEL`; that env var stays supported as an
 * extra/override for serving a different label.
 */
export function resolveControlPlaneTaskConfig(
  relay: { controlPlaneUrl?: string; enrollmentToken?: string } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  nodeName?: string,
  capabilities: string[] = [],
): ControlPlaneTaskConfig | null {
  // Enrollment opts the node into the hosted work queue. This cannot be gated
  // on GitHub configuration: Slack, signed webhooks, schedules, and manually
  // dispatched runs use the same queue and may be the only integration enabled.
  if (!relay?.controlPlaneUrl || !relay.enrollmentToken) return null;

  const base = (env.BIVY_GITHUB_LABEL?.trim() || "bivy");
  // The label the node serves for its own name, e.g. name "hetzner" → "bivy/hetzner".
  const nameLabel = nodeName?.trim() ? `${base}/${nodeName.trim()}` : undefined;
  // BIVY_NODE_LABEL may be a full label ("bivy/x") or a bare suffix ("x").
  const rawEnvLabel = env.BIVY_NODE_LABEL?.trim();
  const envLabel = rawEnvLabel ? (rawEnvLabel.includes("/") ? rawEnvLabel : `${base}/${rawEnvLabel}`) : undefined;
  const labels = Array.from(new Set([base, nameLabel, envLabel].filter(Boolean) as string[]));
  return {
    controlPlaneUrl: relay.controlPlaneUrl.replace(/\/$/, ""),
    enrollmentToken: relay.enrollmentToken,
    labels: labels.length ? labels : ["bivy"],
    pollMs: Math.max(Number(env.BIVY_GITHUB_POLL_MS) || 60_000, 10_000),
    capabilities,
  };
}

async function cp(cfg: ControlPlaneTaskConfig, method: string, path: string, claimToken?: string, body?: unknown): Promise<Response> {
  return fetch(`${cfg.controlPlaneUrl}${path}`, {
    method,
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${cfg.enrollmentToken}`, 'content-type': 'application/json', ...(claimToken ? { 'x-bivy-work-claim': claimToken } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function sendWorkResult(cfg: ControlPlaneTaskConfig, result: WorkResult): Promise<'acknowledged' | 'lost' | 'retry'> {
  try {
    const res = await cp(cfg, 'POST', `/node/work/${encodeURIComponent(result.id)}/${result.action}`, result.claimToken);
    if (res.ok) return 'acknowledged';
    if (res.status === 409 || res.status === 404) return 'lost';
  } catch { /* Outbox retains the intent; retry delivery without agent work. */ }
  return 'retry';
}

async function transitionWork(cfg: ControlPlaneTaskConfig, id: string, action: string): Promise<void> {
  // Best-effort — a dropped transition never loses the run itself — but NOT
  // silent: a swallowed `complete`/`fail`/`needs-attention` leaves the control
  // plane's view of the item stale (stuck "running", or re-dispatched), so the
  // failure must be visible in node logs/diagnostics rather than discarded (A4).
  try {
    const res = await cp(cfg, "POST", `/node/work/${encodeURIComponent(id)}/${action}`);
    if (!res.ok) {
      console.warn(`[control-plane-tasks] work ${id} "${action}" rejected by control plane (${res.status}); its status may be stale`);
    }
  } catch (error) {
    console.warn(`[control-plane-tasks] work ${id} "${action}" could not reach control plane:`, error instanceof Error ? error.message : error);
  }
}

export async function fetchPendingWork(cfg: ControlPlaneTaskConfig): Promise<WorkItem[]> {
  const res = await cp(cfg, "GET", `/node/work?labels=${encodeURIComponent(cfg.labels.join(","))}`);
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { items?: WorkItem[] };
  return Array.isArray(data.items) ? data.items : [];
}

/** Consume the authoritative claim snapshot, not the earlier queue listing. */
export async function claimWork(cfg: ControlPlaneTaskConfig, id: string): Promise<WorkItem | undefined> {
  const res = await cp(cfg, "POST", `/node/work/${encodeURIComponent(id)}/claim`, randomUUID());
  if (!res.ok) return undefined;
  const data = await res.json() as { item?: WorkItem };
  return data.item ?? { id } as WorkItem; // compatibility with older control planes
}

export type WorkLeaseRenewal = "renewed" | "cancelled" | "lost";

/** Renew ownership and retain the reason a renewal was rejected. Cancellation is
 *  intentionally distinct from a generic lost lease so an active agent can be
 *  stopped promptly when the account cancels its Run. */
export async function renewWorkLease(cfg: ControlPlaneTaskConfig, id: string): Promise<WorkLeaseRenewal> {
  const res = await cp(cfg, "POST", `/node/work/${encodeURIComponent(id)}/heartbeat`);
  if (res.ok) return "renewed";
  const data = (await res.json().catch(() => ({}))) as { reason?: unknown };
  return data.reason === "cancelled" ? "cancelled" : "lost";
}

export async function completeWork(cfg: ControlPlaneTaskConfig, id: string): Promise<void> {
  await transitionWork(cfg, id, "complete");
}

export async function failWork(cfg: ControlPlaneTaskConfig, id: string): Promise<void> {
  await transitionWork(cfg, id, "fail");
}

/** Park a run for a human (dormant `needs_attention` status). Best-effort. */
export async function needsAttentionWork(cfg: ControlPlaneTaskConfig, id: string): Promise<void> {
  await transitionWork(cfg, id, "needs-attention");
}

/** Report privacy-safe run evidence (issue #153) — routing reason, output refs
 *  (branch/PR/checkpoint/commit/...), check results, and new timeline events.
 *  Best-effort: a dropped report loses one evidence update, never the run
 *  itself. It is not throwing, but the failure is logged (A4) so a persistently
 *  failing evidence channel is visible in diagnostics instead of silent. */
export async function reportEvidence(cfg: ControlPlaneTaskConfig, id: string, patch: EvidencePatch, claimToken?: string): Promise<void> {
  try {
    const res = await fetch(`${cfg.controlPlaneUrl}/node/work/${encodeURIComponent(id)}/evidence`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.enrollmentToken}`, "content-type": "application/json", ...(claimToken ? { 'x-bivy-work-claim': claimToken } : {}) },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      console.warn(`[control-plane-tasks] work ${id} evidence report rejected (${res.status})`);
    }
  } catch (error) {
    console.warn(`[control-plane-tasks] work ${id} evidence report could not reach control plane:`, error instanceof Error ? error.message : error);
  }
}

/** Optional policy hooks — when omitted the poller keeps its historical behavior
 *  (any thrown error fails the run immediately). */
export interface ControlPlaneTaskPollerOptions {
  /** Daemon-owned metadata directory for crash-safe outcome delivery. */
  resultDirectory?: string;
  /** Decides retry/reroute/park/give_up when an attempt throws. A resolver
   *  allows repository-owned policy to be selected per work item. */
  policy?: RunPolicy | ((item: WorkItem) => RunPolicy | undefined);
  /** Injectable sleep for backoff waits (deterministic in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Lease heartbeat cadence. Primarily useful for deterministic focused tests. */
  leaseHeartbeatMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type RunState = "active" | "cancelled" | "lost";
interface InFlightRun {
  controller: AbortController;
  state: RunState;
  heartbeat?: NodeJS.Timeout;
  leaseCheck?: Promise<void>;
  claimToken?: string;
  deadline?: NodeJS.Timeout;
}

export class ControlPlaneTaskPoller {
  private timer?: NodeJS.Timeout;
  /** Keep the controller alongside the reservation: relay pokes can arrive at
   *  any point from claim through policy retries and must address the same Run. */
  private inFlight = new Map<string, InFlightRun>();
  private readonly policy?: RunPolicy | ((item: WorkItem) => RunPolicy | undefined);
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly leaseHeartbeatMs: number;
  private readonly outbox: WorkResultOutbox;
  private flushingResults?: Promise<void>;

  constructor(
    private readonly cfg: ControlPlaneTaskConfig,
    private readonly runItem: (item: WorkItem, report: (patch: EvidencePatch) => Promise<void>, signal: AbortSignal) => Promise<void>,
    /** Node's cap on concurrently-running queue sessions (0/undefined = unlimited).
     *  Read fresh each tick so the Settings → Nodes value takes effect live. */
    private readonly maxConcurrent?: () => number,
    options: ControlPlaneTaskPollerOptions = {},
  ) {
    this.policy = options.policy;
    this.sleep = options.sleep ?? defaultSleep;
    this.leaseHeartbeatMs = options.leaseHeartbeatMs ?? 30_000;
    this.outbox = new WorkResultOutbox(options.resultDirectory, `${cfg.controlPlaneUrl}:${cfg.enrollmentToken}`);
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.cfg.pollMs);
    this.timer.unref?.();
    console.log(`[control-plane-tasks] watching hosted queue for labels [${this.cfg.labels.join(", ")}] (relay push + ${Math.round(this.cfg.pollMs / 1000)}s fallback poll)`);
  }

  /** React to a relay work notification. If it names a Run already executing,
   *  check its lease immediately (the notification may be its cancellation);
   *  otherwise fetch the queue as before. The optional id keeps old callers
   *  that only use poke() fully compatible. */
  poke(id?: string): void {
    const run = id ? this.inFlight.get(id) : undefined;
    if (id && run) {
      void this.checkLease(id, run);
      return;
    }
    void this.tick();
  }

  /** Include undelivered results so an ephemeral machine cannot tear down its
   * only durable outbox while completion reconciliation is still pending. */
  inFlightCount(): number {
    return new Set([...this.inFlight.keys(), ...this.outbox.list().map(result => result.id)]).size;
  }

  /**
   * Replace the routing labels this live poller serves.
   *
   * Node names are editable while the daemon is running, and targeted queue
   * labels are derived from that name (`bivy/<name>`). Keeping the startup-time
   * labels forever leaves work routed to a renamed node pending until the daemon
   * restarts. Update in place so already-running queue jobs are not disturbed,
   * then poll immediately for work addressed to the new name.
   */
  setLabels(labels: string[]): void {
    const next = Array.from(new Set(labels.map((label) => label.trim()).filter(Boolean)));
    if (!next.length || (next.length === this.cfg.labels.length && next.every((label, i) => label === this.cfg.labels[i]))) return;
    this.cfg.labels = next;
    console.log(`[control-plane-tasks] now watching hosted queue for labels [${next.join(", ")}]`);
    this.poke();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    await this.flushResults();
    let items: WorkItem[];
    try {
      items = await fetchPendingWork(this.cfg);
    } catch {
      return;
    }
    const max = this.maxConcurrent?.() ?? 0;
    const running: Promise<void>[] = [];
    for (const item of items) {
      if (this.inFlight.has(item.id) || this.outbox.has(item.id)) continue;
      // Hard block: never contend for an item requiring a capability this
      // node hasn't declared. It stays pending for a node that has it (or
      // parks account-wide if the control plane found none at enqueue time).
      if (!capabilityEligible(this.cfg.capabilities ?? [], item.requiredCapabilities)) continue;
      // Honor the node's concurrency cap: leave the rest in the queue for a later
      // tick (or an idle node) to claim when a slot frees.
      if (max > 0 && this.inFlight.size >= max) break;
      // Reserve the slot synchronously (no `await` since the last check) so a
      // later item considered in this same loop sees an accurate
      // `inFlight.size` — then kick it off without awaiting it here (only
      // collecting the promise to await below). Awaiting an item to completion
      // before starting the next one meant the cap was never really exercised
      // within a single tick: items ran one at a time regardless of `max`, and
      // only overlapping `setInterval` ticks happened to run more than one
      // concurrently.
      const run: InFlightRun = { controller: new AbortController(), state: "active" };
      this.inFlight.set(item.id, run);
      running.push(this.runOne(item, run));
    }
    await Promise.all(running);
  }

  private async runOne(item: WorkItem, reserved?: InFlightRun): Promise<void> {
    // runOne is exercised directly by a few callers/tests, so create a control
    // when there was no tick reservation. Never replace an existing control.
    const run = reserved ?? this.inFlight.get(item.id) ?? { controller: new AbortController(), state: "active" };
    if (!this.inFlight.has(item.id)) this.inFlight.set(item.id, run);
    try {
      // Soft preference ranking: a node matching fewer of the item's preferred
      // capability tags waits slightly longer before attempting to claim,
      // giving a better-matching Machine first opportunity. Any node can still
      // win the claim once its delay elapses — this never refuses to run.
      const delayMs = capabilityClaimDelayMs(this.cfg.capabilities ?? [], item.preferredCapabilities);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (run.state !== "active") return;
      // Claim first so only one node runs it; skip if another node won (no
      // claim → not ours → don't run or complete it). A heartbeat keeps the
      // finite lease alive; process death stops it and makes the item reclaimable.
      const claimed = await claimWork(this.cfg, item.id);
      if (!claimed || run.state !== 'active') return;
      item = { ...item, ...claimed };
      run.claimToken = claimed.claimToken;
      this.setLeaseDeadline(run, claimed.leaseExpiresAt);
      run.heartbeat = setInterval(() => void this.checkLease(item.id, run), this.leaseHeartbeatMs);
      run.heartbeat.unref?.();
      const report = (patch: EvidencePatch) => reportEvidence(this.cfg, item.id, patch, run.claimToken);
      const started = await cp(this.cfg, 'POST', `/node/work/${encodeURIComponent(item.id)}/running`, run.claimToken);
      if (!started.ok) return; // Never execute after a rejected lifecycle transition.
      if (run.state !== "active") return;
      console.log(`[control-plane-tasks] running ${item.source} item ${item.id}: ${item.title}`);
      // routingReason is a coarse baseline — a manual "Run…" override picked
      // this agent/model explicitly; otherwise it's whatever the queue label
      // routed to. runWorkItem/runIssueTask may layer a more specific reason
      // (e.g. a fallback after an error) on top via the same `report` hook.
      await report({ routingReason: item.runtimeId || item.model ? "manual override" : "queue label" });
      if (run.state !== "active") return;
      await this.runWithPolicy(item, report, run);
    } catch (error) {
      console.warn(`[control-plane-tasks] work ${item.id} orchestration failed:`, error);
    } finally {
      if (run.heartbeat) clearInterval(run.heartbeat);
      if (run.deadline) clearTimeout(run.deadline);
      // A stale completion must not remove a newer reservation for the same id.
      if (this.inFlight.get(item.id) === run) this.inFlight.delete(item.id);
    }
  }

  private setLeaseDeadline(run: InFlightRun, expiry?: string): void {
    if (!expiry && !run.claimToken) return; // legacy servers do not advertise a lease
    const remaining = expiry ? Date.parse(expiry) - Date.now() : 0;
    if (run.deadline) clearTimeout(run.deadline);
    const lose = () => {
      if (run.state !== 'active') return;
      run.state = 'lost';
      run.controller.abort(new Error('Run lease expired without confirmed renewal'));
      if (run.heartbeat) clearInterval(run.heartbeat);
    };
    if (!Number.isFinite(remaining) || remaining <= 0) { lose(); return; }
    run.deadline = setTimeout(lose, Math.max(1, remaining - Math.min(1000, remaining / 10)));
    run.deadline.unref?.();
  }

  private flushResults(): Promise<void> {
    if (this.flushingResults) return this.flushingResults;
    this.flushingResults = (async () => {
      for (const result of this.outbox.list()) {
        // Active workers own their delivery/heartbeat loop.
        if (this.inFlight.has(result.id)) continue;
        const status = await sendWorkResult(this.cfg, result);
        if (status !== 'retry') this.outbox.remove(result.id);
      }
    })().catch(error => console.warn('[control-plane-tasks] outcome reconciliation failed:', error))
      .finally(() => { this.flushingResults = undefined; });
    return this.flushingResults;
  }

  private async finishWork(id: string, action: WorkResult['action'], run: InFlightRun): Promise<void> {
    const result = { id, action, claimToken: run.claimToken };
    this.outbox.put(result);
    // Keep ownership while retrying delivery, but never beyond its confirmed
    // deadline. After a restart the outbox is reconciled before queue intake.
    do {
      const status = await sendWorkResult(this.cfg, result);
      if (status !== 'retry') { this.outbox.remove(id); return; }
      if (!run.claimToken) return; // legacy server: retain for the recovery poll
      await this.sleep(1000);
    } while (run.state === 'active');
  }

  private checkLease(id: string, run: InFlightRun): Promise<void> {
    if (run.state !== "active") return Promise.resolve();
    if (run.leaseCheck) return run.leaseCheck;
    run.leaseCheck = (async () => {
      try {
        const response = await cp(this.cfg, 'POST', `/node/work/${encodeURIComponent(id)}/heartbeat`, run.claimToken);
        const data = await response.json() as { leaseExpiresAt?: string; reason?: string };
        if (this.inFlight.get(id) !== run || run.state !== 'active') return;
        if (response.ok) { this.setLeaseDeadline(run, data.leaseExpiresAt); return; }
        if (response.status !== 409 && response.status !== 404) return;
        const renewal = data.reason === 'cancelled' ? 'cancelled' : 'lost';
        run.state = renewal;
        if (run.heartbeat) {
          clearInterval(run.heartbeat);
          run.heartbeat = undefined;
        }
        run.controller.abort(new Error(renewal === "cancelled" ? "Run cancelled" : "Run lease lost"));
      } catch (error) {
        // Transient failures may retry only until the last confirmed deadline.
        console.warn(`[control-plane-tasks] work ${id} heartbeat failed:`, error instanceof Error ? error.message : error);
      } finally {
        run.leaseCheck = undefined;
      }
    })();
    return run.leaseCheck;
  }

  /**
   * Run one item under the run policy: on failure, classify → decide → retry /
   * reroute (rewrite routing for the next attempt) / park (needs_attention) /
   * give_up (fail). Reroute happens only at ATTEMPT BOUNDARIES — the failed
   * attempt is fully unwound before the next one starts — so there's no partial-
   * work/idempotency hazard. Every decision is recorded as a bounded, privacy-
   * safe evidence event. With no policy injected this is the historical path:
   * one attempt, any throw fails the run.
   */
  private async runWithPolicy(item: WorkItem, report: (patch: EvidencePatch) => Promise<void>, run: InFlightRun): Promise<void> {
    let current = item;
    let attempt = Math.max(1, item.attempt ?? 1);
    let rerouteCount = 0;
    for (;;) {
      if (run.state !== "active") return;
      try {
        // Functions declared with the historical two arguments remain valid in
        // TypeScript/JavaScript; cancellation-aware runners can use the third.
        await this.runItem({ ...current, attempt }, report, run.controller.signal);
        if (run.state !== "active") return;
        await this.finishWork(item.id, 'complete', run);
        return;
      } catch (error) {
        // Abort errors are ordinary throws to the policy layer unless guarded.
        // A cancelled/lost Run has no node-side terminal transition or retry.
        if (this.outbox.has(item.id)) {
          console.error(`[control-plane-tasks] work ${item.id} result delivery/persistence failed; agent will not be retried:`, error);
          return;
        }
        if (run.state !== "active") return;
        // Deployment admission is not an agent failure. Never reroute/retry it
        // through a provider policy or mark the work successfully completed.
        if (error instanceof RemoteSessionAdmissionError) {
          const now = new Date().toISOString();
          await report({
            events: [{ at: now, kind: "policy_denial", summary: error.message, reasonCode: error.code, status: "denied", attempt }],
            attention: { severity: "warning", reason: error.message, since: now },
          });
          if (run.state !== "active") return;
          await this.finishWork(item.id, 'needs-attention', run);
          return;
        }
        const policy = typeof this.policy === "function" ? this.policy(current) : this.policy;
        const decision: RunDecision = policy?.decide({
          routing: { runtimeId: current.runtimeId, model: current.model },
          error,
          attempt,
          rerouteCount,
        }) ?? { action: "give_up", condition: "unknown" };

        // Per-automation hard ceiling wins over a broader node ruleset. Park
        // rather than silently fail so a human can inspect or rerun it.
        const maxAttempts = Math.max(1, Math.min(10, Number(current.maxAttempts) || 10));
        if ((decision.action === "retry" || decision.action === "reroute") && attempt >= maxAttempts) {
          const summary = `Attempt limit reached (${maxAttempts}); automation parked for review.`;
          console.warn(`[control-plane-tasks] item ${item.id} needs attention: ${summary}`);
          await report({ events: [{ at: new Date().toISOString(), kind: "needs_attention", summary, attempt }] });
          if (run.state !== "active") return;
          await this.finishWork(item.id, 'needs-attention', run);
          return;
        }

        if (decision.action === "retry" || decision.action === "reroute") {
          if (run.claimToken) {
            const response = await cp(this.cfg, 'POST', `/node/work/${encodeURIComponent(item.id)}/attempt`, run.claimToken, { attempt });
            if (!response.ok) { await this.finishWork(item.id, 'needs-attention', run); return; }
            const data = await response.json() as { item: WorkItem };
            attempt = data.item.attempt!;
          } else { attempt += 1; } // legacy control plane
          const kind = decision.action === "retry" ? "retry" : "fallback";
          console.warn(`[control-plane-tasks] item ${item.id} ${kind} (${decision.condition}): ${decision.summary}`);
          await report({
            events: [
              {
                at: new Date().toISOString(),
                kind,
                summary: decision.summary,
                attempt,
                ...(decision.action === "reroute" ? { ref: decision.ref } : {}),
              },
            ],
          });
          if (decision.action === "reroute") {
            // A candidate changes only the routing dimensions it names. Preserve
            // the existing runtime/model for partial fallback routes (for example
            // a model-only fallback must not silently reset the selected agent).
            current = {
              ...current,
              ...(decision.routing.runtimeId !== undefined ? { runtimeId: decision.routing.runtimeId } : {}),
              ...(decision.routing.model !== undefined ? { model: decision.routing.model } : {}),
              // Account routing is not yet represented by WorkItem. Do not claim
              // that an account fallback was applied until the queue wire shape
              // and credential resolver support it end-to-end.
            };
            rerouteCount = decision.rerouteCount;
            await report({ routingReason: `fallback: ${decision.ref}` });
          }
          if (decision.delayMs > 0) await this.sleep(decision.delayMs);
          if (run.state !== "active") return;
          continue;
        }

        if (decision.action === "park") {
          console.warn(`[control-plane-tasks] item ${item.id} needs attention (${decision.condition}): ${decision.summary}`);
          await report({ events: [{ at: new Date().toISOString(), kind: "needs_attention", summary: decision.summary }] });
          if (run.state !== "active") return;
          await this.finishWork(item.id, 'needs-attention', run);
          return;
        }

        console.warn(`[control-plane-tasks] item ${item.id} failed:`, error);
        if (run.state !== "active") return;
        await this.finishWork(item.id, 'fail', run);
        return;
      }
    }
  }
}
