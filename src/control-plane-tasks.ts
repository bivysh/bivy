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

import type { RunDecision, RunPolicy } from "./policy/run-policy.js";

export interface ControlPlaneTaskConfig {
  controlPlaneUrl: string;
  enrollmentToken: string;
  labels: string[]; // the labels this node serves, e.g. ["bivy", "bivy/laptop"]
  pollMs: number;
}

export interface WorkItem {
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
  };
}

async function cp(cfg: ControlPlaneTaskConfig, method: string, path: string): Promise<Response> {
  return fetch(`${cfg.controlPlaneUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${cfg.enrollmentToken}` },
  });
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

/** Atomically claim an item. Returns true only if THIS node won the claim. */
export async function claimWork(cfg: ControlPlaneTaskConfig, id: string): Promise<boolean> {
  const res = await cp(cfg, "POST", `/node/work/${encodeURIComponent(id)}/claim`);
  return res.ok;
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
export async function reportEvidence(cfg: ControlPlaneTaskConfig, id: string, patch: EvidencePatch): Promise<void> {
  try {
    const res = await fetch(`${cfg.controlPlaneUrl}/node/work/${encodeURIComponent(id)}/evidence`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.enrollmentToken}`, "content-type": "application/json" },
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
}

export class ControlPlaneTaskPoller {
  private timer?: NodeJS.Timeout;
  /** Keep the controller alongside the reservation: relay pokes can arrive at
   *  any point from claim through policy retries and must address the same Run. */
  private inFlight = new Map<string, InFlightRun>();
  private readonly policy?: RunPolicy | ((item: WorkItem) => RunPolicy | undefined);
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly leaseHeartbeatMs: number;

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
  }

  start(): void {
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

  /** Number of queue items currently running on this node. Lets an ephemeral
   *  machine's self-teardown avoid exiting while it's mid-work. */
  inFlightCount(): number {
    return this.inFlight.size;
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
  }

  private async tick(): Promise<void> {
    let items: WorkItem[];
    try {
      items = await fetchPendingWork(this.cfg);
    } catch {
      return;
    }
    const max = this.maxConcurrent?.() ?? 0;
    const running: Promise<void>[] = [];
    for (const item of items) {
      if (this.inFlight.has(item.id)) continue;
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
      // Claim first so only one node runs it; skip if another node won (no
      // claim → not ours → don't run or complete it). A heartbeat keeps the
      // finite lease alive; process death stops it and makes the item reclaimable.
      if (!(await claimWork(this.cfg, item.id)) || run.state !== "active") return;
      run.heartbeat = setInterval(() => void this.checkLease(item.id, run), this.leaseHeartbeatMs);
      run.heartbeat.unref?.();
      const report = (patch: EvidencePatch) => reportEvidence(this.cfg, item.id, patch);
      await transitionWork(this.cfg, item.id, "running");
      if (run.state !== "active") return;
      console.log(`[control-plane-tasks] running ${item.source} item ${item.id}: ${item.title}`);
      // routingReason is a coarse baseline — a manual "Run…" override picked
      // this agent/model explicitly; otherwise it's whatever the queue label
      // routed to. runWorkItem/runIssueTask may layer a more specific reason
      // (e.g. a fallback after an error) on top via the same `report` hook.
      await report({ routingReason: item.runtimeId || item.model ? "manual override" : "queue label" });
      if (run.state !== "active") return;
      await this.runWithPolicy(item, report, run);
    } finally {
      if (run.heartbeat) clearInterval(run.heartbeat);
      // A stale completion must not remove a newer reservation for the same id.
      if (this.inFlight.get(item.id) === run) this.inFlight.delete(item.id);
    }
  }

  private checkLease(id: string, run: InFlightRun): Promise<void> {
    if (run.state !== "active") return Promise.resolve();
    if (run.leaseCheck) return run.leaseCheck;
    run.leaseCheck = (async () => {
      try {
        const renewal = await renewWorkLease(this.cfg, id);
        if (renewal === "renewed" || this.inFlight.get(id) !== run || run.state !== "active") return;
        run.state = renewal;
        if (run.heartbeat) {
          clearInterval(run.heartbeat);
          run.heartbeat = undefined;
        }
        run.controller.abort(new Error(renewal === "cancelled" ? "Run cancelled" : "Run lease lost"));
      } catch (error) {
        // A transient network error does not prove ownership was lost. Keep the
        // Run alive and let the next heartbeat retry.
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
    let attempt = 1;
    let rerouteCount = 0;
    for (;;) {
      if (run.state !== "active") return;
      try {
        // Functions declared with the historical two arguments remain valid in
        // TypeScript/JavaScript; cancellation-aware runners can use the third.
        await this.runItem(current, report, run.controller.signal);
        if (run.state !== "active") return;
        await completeWork(this.cfg, item.id);
        return;
      } catch (error) {
        // Abort errors are ordinary throws to the policy layer unless guarded.
        // A cancelled/lost Run has no node-side terminal transition or retry.
        if (run.state !== "active") return;
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
          await needsAttentionWork(this.cfg, item.id);
          return;
        }

        if (decision.action === "retry" || decision.action === "reroute") {
          attempt += 1;
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
            current = { ...current, runtimeId: decision.routing.runtimeId, model: decision.routing.model };
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
          await needsAttentionWork(this.cfg, item.id);
          return;
        }

        console.warn(`[control-plane-tasks] item ${item.id} failed:`, error);
        if (run.state !== "active") return;
        await failWork(this.cfg, item.id);
        return;
      }
    }
  }
}
