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

export interface ControlPlaneTaskConfig {
  controlPlaneUrl: string;
  enrollmentToken: string;
  labels: string[]; // the labels this node serves, e.g. ["bivy", "bivy/laptop"]
  pollMs: number;
}

export interface WorkItem {
  id: string;
  label: string;
  source: string; // "github:issue" | "github:comment" | "slack"
  status: string;
  title: string;
  body?: string;
  repo?: string; // "owner/repo"
  issueNumber?: number;
  url?: string;
  runtimeId?: string; // agent/runtime override chosen via the queue "Run…" action
  model?: string; // model override chosen via the queue "Run…" action
  approvalMode?: "never" | "risky" | "always" | "autonomous";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  installationId?: string; // GitHub App install to mint a token for (flavor A)
  appId?: string; // which configured app that installation belongs to (a node may serve several)
}

/**
 * The disposition of a completed work item (issue #155's "node run completion
 * reporting"). `evidence` — when present — is the bounded/sanitized
 * `PolicyEvidence` from `@bivy/core/execution-policy` (check ids, exit status,
 * duration, short redacted summaries): never raw command output, diffs, or
 * file contents. The control plane only ever routes/stores this; it never
 * re-derives or overrides it — the node is the sole enforcement authority.
 */
export interface WorkItemOutcome {
  status: "succeeded" | "failed" | "needs_attention";
  evidence?: unknown;
}

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
  // Opt-in: only poll the hosted queue when enrolled AND issue pickup is enabled
  // (the same switch as github-tasks, so a node doesn't poll unexpectedly).
  if (!relay?.controlPlaneUrl || !relay.enrollmentToken) return null;
  const explicit = Boolean(env.BIVY_GITHUB_TOKEN?.trim() && env.BIVY_GITHUB_REPO?.trim());
  const hostedOptIn = env.BIVY_GITHUB_HOSTED_TASKS === "1" || env.BIVY_GITHUB_TASKS === "1";
  const appConfigured = Boolean(env.BIVY_GITHUB_APP_ID?.trim()); // GitHub App = hosted queue
  if (!hostedOptIn && !explicit && !appConfigured) return null;
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

async function cp(cfg: ControlPlaneTaskConfig, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${cfg.controlPlaneUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.enrollmentToken}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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

/** Report a work item's non-failure disposition ("succeeded" or
 *  "needs_attention"). Defaults to "succeeded" for back-compat with any
 *  caller that hasn't adopted policy evidence yet. A hard policy violation
 *  goes through `failWork` below instead. */
export async function completeWork(cfg: ControlPlaneTaskConfig, id: string, outcome?: WorkItemOutcome): Promise<void> {
  await cp(cfg, "POST", `/node/work/${encodeURIComponent(id)}/complete`, outcome ?? { status: "succeeded" }).catch(() => {});
}

/** Report a work item as failed, optionally with bounded/sanitized policy
 *  evidence explaining why (issue #155). */
export async function failWork(cfg: ControlPlaneTaskConfig, id: string, evidence?: unknown): Promise<void> {
  await cp(cfg, "POST", `/node/work/${encodeURIComponent(id)}/fail`, evidence !== undefined ? { evidence } : undefined).catch(() => {});
}

export class ControlPlaneTaskPoller {
  private timer?: NodeJS.Timeout;
  private inFlight = new Set<string>();

  constructor(
    private readonly cfg: ControlPlaneTaskConfig,
    private readonly runItem: (item: WorkItem) => Promise<WorkItemOutcome | void>,
    /** Node's cap on concurrently-running queue sessions (0/undefined = unlimited).
     *  Read fresh each tick so the Settings → Nodes value takes effect live. */
    private readonly maxConcurrent?: () => number,
  ) {}

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
      // Never a false success (issue #155): an item that throws, or whose
      // runner returns nothing, reports "failed" — only an explicit outcome
      // from `runItem` can report success or needs_attention.
      let outcome: WorkItemOutcome = { status: "failed" };
      try {
        await transitionWork(this.cfg, item.id, "running");
        console.log(`[control-plane-tasks] running ${item.source} item ${item.id}: ${item.title}`);
        outcome = (await this.runItem(item)) ?? { status: "failed" };
      } catch (error) {
        console.warn(`[control-plane-tasks] item ${item.id} failed:`, error);
      } finally {
        // Mark done so it leaves the queue even if the run threw — a failed
        // item shouldn't be retried forever (it's recorded on the issue/PR).
        // "failed" is reported through /fail (a hard policy violation, or an
        // uncaught error/no outcome); "succeeded"/"needs_attention" through
        // /complete — see the endpoint split in services/control-plane.
        if (outcome.status === "failed") await failWork(this.cfg, item.id, outcome.evidence);
        else await completeWork(this.cfg, item.id, outcome);
      }
    } finally {
      this.inFlight.delete(item.id);
    }
  }
}
