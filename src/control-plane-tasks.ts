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
  installationId?: string; // GitHub App install to mint a token for (flavor A)
  appId?: string; // which configured app that installation belongs to (a node may serve several)
  attempts?: WorkAttempt[];
}
export interface WorkAttempt {
  id: string;
  number: number;
  sessionId?: string;
  checkpointId?: string;
  worktreePath?: string;
}
export interface WorkRunMetadata {
  sessionId?: string;
  checkpointId?: string;
  worktreePath?: string;
  resumed?: boolean;
}
export type WorkFailureClass = "transient" | "provider_quota" | "provider_auth" | "agent_error" | "task_failure" | "policy_denial" | "cancellation" | "unknown";

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
    headers: { authorization: `Bearer ${cfg.enrollmentToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function fetchPendingWork(cfg: ControlPlaneTaskConfig): Promise<WorkItem[]> {
  const res = await cp(cfg, "GET", `/node/work?labels=${encodeURIComponent(cfg.labels.join(","))}`);
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { items?: WorkItem[] };
  return Array.isArray(data.items) ? data.items : [];
}

/** Atomically claim an item. Returns true only if THIS node won the claim. */
export async function claimWork(cfg: ControlPlaneTaskConfig, id: string): Promise<WorkAttempt | undefined> {
  const res = await cp(cfg, "POST", `/node/work/${encodeURIComponent(id)}/claim`);
  if (!res.ok) return undefined;
  const data = await res.json().catch(() => ({})) as { attempt?: WorkAttempt };
  return data.attempt;
}

async function updateAttempt(cfg: ControlPlaneTaskConfig, itemId: string, attemptId: string, action: "heartbeat" | "finish", body: unknown): Promise<{ ok: boolean; status?: string }> {
  const res = await cp(cfg, "POST", `/node/work/${encodeURIComponent(itemId)}/attempts/${encodeURIComponent(attemptId)}/${action}`, body);
  const data = await res.json().catch(() => ({})) as { item?: { status?: string } };
  return { ok: res.ok, status: data.item?.status };
}

/** Stable, intentionally conservative classification: only transport/node loss retries automatically. */
export function classifyWorkFailure(error: unknown): { failureClass: WorkFailureClass; attentionReason?: "credentials" | "approval" | "merge_conflict" | "policy"; status: "failed" | "needs_attention" | "cancelled"; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const text = `${message} ${(error as { code?: string } | null)?.code ?? ""}`.toLowerCase();
  if (/abort|cancel/.test(text)) return { failureClass: "cancellation", status: "cancelled", message };
  if (/policy|denied|destructive action/.test(text)) return { failureClass: "policy_denial", attentionReason: "policy", status: "needs_attention", message };
  if (/approval|required approval|permission/.test(text)) return { failureClass: "policy_denial", attentionReason: "approval", status: "needs_attention", message };
  if (/merge conflict|conflict.*merge|unmerged files/.test(text)) return { failureClass: "task_failure", attentionReason: "merge_conflict", status: "needs_attention", message };
  if (/401|403|unauthori[sz]ed|invalid.*(?:token|key)|credential|login required|authentication/.test(text)) return { failureClass: "provider_auth", attentionReason: "credentials", status: "needs_attention", message };
  if (/429|quota|rate.?limit|insufficient_quota|usage limit/.test(text)) return { failureClass: "provider_quota", attentionReason: "credentials", status: "needs_attention", message };
  if (/econn|etimedout|timeout|socket|network|fetch failed|connection|node.*(?:lost|offline)|service unavailable|502|503|504/.test(text)) return { failureClass: "transient", status: "failed", message };
  if (/test(?:s)? failed|task failed|exit code/.test(text)) return { failureClass: "task_failure", status: "failed", message };
  if (/agent|model/.test(text)) return { failureClass: "agent_error", status: "failed", message };
  return { failureClass: "unknown", status: "failed", message };
}

export class ControlPlaneTaskPoller {
  private timer?: NodeJS.Timeout;
  private inFlight = new Set<string>();

  constructor(
    private readonly cfg: ControlPlaneTaskConfig,
    private readonly runItem: (item: WorkItem, resume?: WorkAttempt, report?: (metadata: WorkRunMetadata) => void) => Promise<WorkRunMetadata | void>,
    /** Node's cap on concurrently-running queue sessions (0/undefined = unlimited).
     *  Read fresh each tick so the Settings → Nodes value takes effect live. */
    private readonly maxConcurrent?: () => number,
    private readonly notifyFinal?: (item: WorkItem, status: "failed" | "needs_attention", message: string) => Promise<void> | void,
    private readonly stopStaleRun?: (metadata: WorkRunMetadata) => Promise<void> | void,
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
      const attempt = await claimWork(this.cfg, item.id);
      if (!attempt) return;
      let leaseCurrent = true;
      let metadata: WorkRunMetadata = {};
      const heartbeat = setInterval(() => {
        void updateAttempt(this.cfg, item.id, attempt.id, "heartbeat", metadata).then((result) => {
          if (leaseCurrent && !result.ok) void this.stopStaleRun?.(metadata);
          leaseCurrent = result.ok;
        }).catch(() => {
          if (leaseCurrent) void this.stopStaleRun?.(metadata);
          leaseCurrent = false;
        });
      }, 15_000);
      heartbeat.unref?.();
      try {
        console.log(`[control-plane-tasks] running ${item.source} item ${item.id}: ${item.title}`);
        metadata = (await this.runItem(item, item.attempts?.at(-1), (next) => {
          metadata = { ...metadata, ...next };
          void updateAttempt(this.cfg, item.id, attempt.id, "heartbeat", metadata).then((result) => {
            if (leaseCurrent && !result.ok) void this.stopStaleRun?.(metadata);
            leaseCurrent = result.ok;
          }).catch(() => {
            if (leaseCurrent) void this.stopStaleRun?.(metadata);
            leaseCurrent = false;
          });
        })) ?? metadata;
        if (leaseCurrent) {
          const renewed = await updateAttempt(this.cfg, item.id, attempt.id, "heartbeat", metadata);
          leaseCurrent = renewed.ok;
          if (!leaseCurrent) return;
          await updateAttempt(this.cfg, item.id, attempt.id, "finish", { status: "succeeded" });
        }
      } catch (error) {
        console.warn(`[control-plane-tasks] item ${item.id} failed:`, error);
        const failure = classifyWorkFailure(error);
        if (leaseCurrent) {
          const result = await updateAttempt(this.cfg, item.id, attempt.id, "finish", failure);
          if (result.status === "failed" || result.status === "needs_attention") await this.notifyFinal?.(item, result.status, failure.message);
        }
      } finally {
        clearInterval(heartbeat);
      }
    } finally {
      this.inFlight.delete(item.id);
    }
  }
}
