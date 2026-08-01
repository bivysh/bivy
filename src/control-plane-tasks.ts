// SPDX-License-Identifier: FSL-1.1-ALv2
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
  repo?: string; // "owner/repo"
  issueNumber?: number;
  externalId?: string; // provider-native id, e.g. Linear issue UUID
  url?: string;
  runtimeId?: string; // agent/runtime override chosen via the queue "Run…" action
  model?: string; // model override chosen via the queue "Run…" action
  approvalMode?: "never" | "risky" | "always" | "autonomous";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  installationId?: string; // GitHub App install to mint a token for (flavor A)
  appId?: string; // which configured app that installation belongs to (a node may serve several)
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
  await cp(cfg, "POST", `/node/work/${encodeURIComponent(id)}/${action}`).catch(() => {});
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
 *  itself, so failures here are swallowed like the other transition calls. */
export async function reportEvidence(cfg: ControlPlaneTaskConfig, id: string, patch: EvidencePatch): Promise<void> {
  await fetch(`${cfg.controlPlaneUrl}/node/work/${encodeURIComponent(id)}/evidence`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.enrollmentToken}`, "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).catch(() => {});
}

/** Optional policy hooks — when omitted the poller keeps its historical behavior
 *  (any thrown error fails the run immediately). */
export interface ControlPlaneTaskPollerOptions {
  /** Decides retry/reroute/park/give_up when an attempt throws. */
  policy?: RunPolicy;
  /** Injectable sleep for backoff waits (deterministic in tests). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class ControlPlaneTaskPoller {
  private timer?: NodeJS.Timeout;
  private inFlight = new Set<string>();
  private readonly policy?: RunPolicy;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly cfg: ControlPlaneTaskConfig,
    private readonly runItem: (item: WorkItem, report: (patch: EvidencePatch) => Promise<void>) => Promise<void>,
    /** Node's cap on concurrently-running queue sessions (0/undefined = unlimited).
     *  Read fresh each tick so the Settings → Nodes value takes effect live. */
    private readonly maxConcurrent?: () => number,
    options: ControlPlaneTaskPollerOptions = {},
  ) {
    this.policy = options.policy;
    this.sleep = options.sleep ?? defaultSleep;
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.cfg.pollMs);
    this.timer.unref?.();
    console.log(`[control-plane-tasks] watching hosted queue for labels [${this.cfg.labels.join(", ")}] (relay push + ${Math.round(this.cfg.pollMs / 1000)}s fallback poll)`);
  }

  /** Trigger an immediate fetch after a relay push says work may be available. */
  poke(): void {
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
      this.inFlight.add(item.id);
      running.push(this.runOne(item));
    }
    await Promise.all(running);
  }

  private async runOne(item: WorkItem): Promise<void> {
    try {
      // Claim first so only one node runs it; skip if another node won (no
      // claim → not ours → don't run or complete it).
      if (!(await claimWork(this.cfg, item.id))) return;
      const report = (patch: EvidencePatch) => reportEvidence(this.cfg, item.id, patch);
      await transitionWork(this.cfg, item.id, "running");
      console.log(`[control-plane-tasks] running ${item.source} item ${item.id}: ${item.title}`);
      // routingReason is a coarse baseline — a manual "Run…" override picked
      // this agent/model explicitly; otherwise it's whatever the queue label
      // routed to. runWorkItem/runIssueTask may layer a more specific reason
      // (e.g. a fallback after an error) on top via the same `report` hook.
      await report({ routingReason: item.runtimeId || item.model ? "manual override" : "queue label" });
      await this.runWithPolicy(item, report);
    } finally {
      this.inFlight.delete(item.id);
    }
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
  private async runWithPolicy(item: WorkItem, report: (patch: EvidencePatch) => Promise<void>): Promise<void> {
    let current = item;
    let attempt = 1;
    let rerouteCount = 0;
    for (;;) {
      try {
        await this.runItem(current, report);
        await completeWork(this.cfg, item.id);
        return;
      } catch (error) {
        const decision: RunDecision = this.policy?.decide({
          routing: { runtimeId: current.runtimeId, model: current.model },
          error,
          attempt,
          rerouteCount,
        }) ?? { action: "give_up", condition: "unknown" };

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
          continue;
        }

        if (decision.action === "park") {
          console.warn(`[control-plane-tasks] item ${item.id} needs attention (${decision.condition}): ${decision.summary}`);
          await report({ events: [{ at: new Date().toISOString(), kind: "needs_attention", summary: decision.summary }] });
          await needsAttentionWork(this.cfg, item.id);
          return;
        }

        console.warn(`[control-plane-tasks] item ${item.id} failed:`, error);
        await failWork(this.cfg, item.id);
        return;
      }
    }
  }
}
