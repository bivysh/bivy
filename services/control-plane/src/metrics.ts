// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Prometheus metrics for the control plane. Exposed at /metrics (internal
// docker-network scrape only; Caddy blocks it publicly). Three groups:
//   1. default Node/process metrics (heap, event-loop lag, CPU, GC) under their
//      standard names, so off-the-shelf Node.js Grafana dashboards work;
//   2. an HTTP request histogram, labelled by matched route PATTERN (never the
//      concrete path), so request ids can't explode label cardinality;
//   3. business/usage gauges refreshed on an interval from the store.
// All app metrics carry a `bivy_` prefix. Metadata only — never session content.
import client from "prom-client";
import type { Request, Response, NextFunction } from "express";
import type { UsageMetrics } from "./store.js";

export interface UsageMetricsReader {
  usageMetrics(): Promise<UsageMetrics>;
}

export const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpDuration = new client.Histogram({
  name: "bivy_http_request_duration_seconds",
  help: "Control-plane HTTP request duration in seconds.",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

/**
 * Express middleware: time every request and record it on response finish under
 * the matched route pattern (e.g. `/nodes/:id`). Requests that match no route
 * are grouped as `unmatched` so 404 scanners can't inflate the series count.
 */
export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const done = httpDuration.startTimer();
  res.on("finish", () => {
    const pattern = req.route?.path;
    const route = pattern ? `${req.baseUrl || ""}${pattern}` : "unmatched";
    done({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}

// Relay-ticket mint outcomes. The ticket path keeps a plain in-process object
// (also served at /metrics.json); this mirrors it into a Prometheus series at
// scrape time rather than duplicating the four increment sites.
export interface RelayTicketCounts {
  nodeMinted: number;
  nodeFailed: number;
  clientMinted: number;
  clientFailed: number;
}
let relayTicketSource: () => RelayTicketCounts = () => ({ nodeMinted: 0, nodeFailed: 0, clientMinted: 0, clientFailed: 0 });

/** Point the relay-ticket gauge at the live counter object from index.ts. */
export function bindRelayTicketMetrics(getter: () => RelayTicketCounts) {
  relayTicketSource = getter;
}

new client.Gauge({
  name: "bivy_relay_tickets_total",
  help: "Relay connection tickets, by role and outcome, since start.",
  labelNames: ["role", "outcome"],
  registers: [register],
  collect() {
    const c = relayTicketSource();
    this.set({ role: "node", outcome: "minted" }, c.nodeMinted);
    this.set({ role: "node", outcome: "failed" }, c.nodeFailed);
    this.set({ role: "client", outcome: "minted" }, c.clientMinted);
    this.set({ role: "client", outcome: "failed" }, c.clientFailed);
  },
});

// --- Product funnel ---------------------------------------------------------

/**
 * Low-cardinality launch funnel milestones. These are aggregate operational
 * analytics, not user tracking: labels are fixed product metadata and the log
 * line deliberately contains no account id, email, session id, or content.
 *
 * The matching structured log makes the events usable before a Prometheus
 * dashboard exists (and gives hosted ops a simple audit trail across restarts,
 * while the in-process Counter resets on restart).
 */
export type FunnelEvent =
  | "sign_in_completed"
  | "sign_in_failed"
  | "node_enrolled";

const funnelEvents = new client.Counter({
  name: "bivy_funnel_events_total",
  help: "Privacy-safe product funnel milestones.",
  labelNames: ["event", "source"],
  registers: [register],
});

export function recordFunnelEvent(event: FunnelEvent, source: string, count = 1): void {
  if (!Number.isFinite(count) || count <= 0) return;
  const safeSource = /^[a-z][a-z0-9_]{0,39}$/.test(source) ? source : "other";
  funnelEvents.inc({ event, source: safeSource }, count);
  console.info(`[funnel] ${JSON.stringify({ event, source: safeSource, count })}`);
}

export const PRODUCT_EVENT_VALUES = [
  "activation_ready",
  "first_useful_response",
  "remote_reconnect",
  "remote_intervention",
  "run_accepted",
  "receipt_reviewed",
  "first_run_machine_ready",
  "first_run_machine_failed",
  "first_run_provider_connected",
  "first_run_provider_failed",
  "first_run_agent_verified",
  "first_run_agent_failed",
] as const;
export type ProductEvent = (typeof PRODUCT_EVENT_VALUES)[number];
export const PRODUCT_CLIENT_VALUES = ["desktop", "mobile", "cli", "node"] as const;
export type ProductClient = (typeof PRODUCT_CLIENT_VALUES)[number];

const productEvents = new client.Counter({
  name: "bivy_product_events_total",
  help: "Privacy-safe activation, remote-continuity, Run, and Receipt milestones.",
  labelNames: ["event", "client"],
  registers: [register],
});

export function recordProductEvent(event: ProductEvent, productClient: ProductClient): void {
  productEvents.inc({ event, client: productClient });
  console.info(`[funnel] ${JSON.stringify({ event, client: productClient })}`);
}

export type RunLifecycleOutcome = "succeeded" | "failed" | "needs_attention" | "cancelled";
export type RunLifecycleRecorder = (outcome: RunLifecycleOutcome) => void;

const runLifecycleResults = new client.Counter({
  name: "bivy_run_lifecycle_results_total",
  help: "Durably transitioned Run lifecycle results.",
  labelNames: ["outcome"],
  registers: [register],
});

export const recordRunLifecycleResult: RunLifecycleRecorder = (outcome) => {
  runLifecycleResults.inc({ outcome });
  console.info(`[funnel] ${JSON.stringify({ event: "run_lifecycle_result", outcome })}`);
};

// Fixed, low-cardinality classification of WHERE an accepted Run stopped short of
// success, so the failure funnel is legible without any per-run identifier. The
// label set is a closed enum; nothing derived from free text or user input.
export type RunFailureStage = "checks" | "timeout" | "agent" | "needs_review";
const runFailureStages = new client.Counter({
  name: "bivy_run_failure_stage_total",
  help: "Durably failed or parked Runs by coarse failure stage.",
  labelNames: ["stage"],
  registers: [register],
});
export type RunFailureStageRecorder = (stage: RunFailureStage) => void;
export const recordRunFailureStage: RunFailureStageRecorder = (stage) => {
  runFailureStages.inc({ stage });
  console.info(`[funnel] ${JSON.stringify({ event: "run_failure_stage", stage })}`);
};

/** Coarse, evidence-derived failure stage for a durably failed/parked Run.
 *  A failed deterministic check dominates; then a timeout signature in the
 *  bounded failure summary; otherwise the agent itself. `parked` marks a Run
 *  routed to a human for review rather than failed outright. */
export function classifyRunFailureStage(
  run: { checks?: Array<{ status: string }>; output?: { failure?: string } } | null | undefined,
  parked = false,
): RunFailureStage {
  if (parked) return "needs_review";
  if (run?.checks?.some((c) => c.status === "failed")) return "checks";
  const failure = (run?.output?.failure ?? "").toLowerCase();
  if (/tim(?:e|ed)\s*-?\s*out|timeout/.test(failure)) return "timeout";
  return "agent";
}

/**
 * Record only a transition result known by its caller to have been persisted.
 * Injection keeps call-placement tests independent of Prometheus global state.
 */
export function recordDurableRunLifecycleResult<T>(
  durableResult: T | null | undefined,
  outcome: RunLifecycleOutcome,
  recorder: RunLifecycleRecorder = recordRunLifecycleResult,
): T | null | undefined {
  if (durableResult != null) recorder(outcome);
  return durableResult;
}

// --- Business / usage gauges ------------------------------------------------

const accountsTotal = new client.Gauge({
  name: "bivy_accounts_total",
  help: "Total registered accounts.",
  registers: [register],
});
const nodesTotal = new client.Gauge({
  name: "bivy_nodes_total",
  help: "Total enrolled nodes.",
  registers: [register],
});
const nodesOnline = new client.Gauge({
  name: "bivy_nodes_online",
  help: "Nodes currently marked online.",
  registers: [register],
});
const workItems = new client.Gauge({
  name: "bivy_work_items",
  help: "Work items by status.",
  labelNames: ["status"],
  registers: [register],
});
const sessions = new client.Gauge({
  name: "bivy_sessions",
  help: "Indexed sessions by status.",
  labelNames: ["status"],
  registers: [register],
});

/**
 * Refresh the business gauges from the store on an interval. Decoupled from the
 * scrape so a slow or briefly-unreachable database never stalls /metrics — a
 * failed round is logged and skipped, leaving the last-known values in place.
 * Returns a stop function. The timer is unref'd so it never holds the process
 * open on its own.
 */
export function startUsageCollector(store: UsageMetricsReader, intervalMs = 30_000): () => void {
  let stopped = false;

  const refresh = async () => {
    try {
      const m = await store.usageMetrics();
      accountsTotal.set(m.accountsTotal);
      nodesTotal.set(m.nodesTotal);
      nodesOnline.set(m.nodesOnline);
      workItems.reset();
      for (const [status, n] of Object.entries(m.workItemsByStatus)) workItems.set({ status }, n);
      sessions.reset();
      for (const [status, n] of Object.entries(m.sessionsByStatus)) sessions.set({ status }, n);
    } catch (error) {
      console.warn("[metrics] usage snapshot failed (will retry):", error instanceof Error ? error.message : String(error));
    }
  };

  void refresh();
  const timer = setInterval(() => {
    if (!stopped) void refresh();
  }, intervalMs);
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
