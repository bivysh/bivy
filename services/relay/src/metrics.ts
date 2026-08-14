// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Prometheus text exposition for the relay, hand-rolled to keep the relay's
// dependency surface at essentially just `ws` — this is boring transport and we
// do not want a metrics client library in its supply chain. The numbers are the
// same operational counters already tracked in index.ts (never payloads); this
// only renders them in the Prometheus format an Alloy/Prometheus scraper reads.

export interface RelayCounters {
  totalConnections: number;
  openConnections: number;
  framesForwarded: number;
  workNotifications: number;
  rejectedAuth: number;
  rejectedRate: number;
  rejectedTooLarge: number;
  rejectedPerIp: number;
  evictedSlow: number;
}

// Prometheus label-value escaping: backslash, double-quote and newline.
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return "";
  return "{" + keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(",") + "}";
}

/**
 * Render the relay's counters as a Prometheus text exposition (version 0.0.4).
 * `shardId` (if set) is attached as a `shard` label so a sharded fleet's series
 * stay distinct in one Prometheus.
 */
export function renderRelayMetrics(m: RelayCounters, rooms: number, shardId: string | null): string {
  const shard: Record<string, string> = shardId ? { shard: shardId } : {};
  const out: string[] = [];

  const metric = (
    name: string,
    help: string,
    type: "gauge" | "counter",
    series: Array<[Record<string, string>, number]>,
  ) => {
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} ${type}`);
    for (const [labels, value] of series) out.push(`${name}${renderLabels(labels)} ${value}`);
  };

  metric("bivy_relay_rooms", "Active rooms (a node plus any connected clients).", "gauge", [[shard, rooms]]);
  metric("bivy_relay_open_connections", "Currently open websocket connections.", "gauge", [[shard, m.openConnections]]);
  metric("bivy_relay_connections_total", "Websocket connections accepted since start.", "counter", [[shard, m.totalConnections]]);
  metric("bivy_relay_frames_forwarded_total", "Frames forwarded since start.", "counter", [[shard, m.framesForwarded]]);
  metric("bivy_relay_work_notifications_total", "work.available notifications delivered since start.", "counter", [[shard, m.workNotifications]]);
  metric("bivy_relay_rejected_total", "Rejected connections/messages since start, by reason.", "counter", [
    [{ ...shard, reason: "auth" }, m.rejectedAuth],
    [{ ...shard, reason: "rate" }, m.rejectedRate],
    [{ ...shard, reason: "too_large" }, m.rejectedTooLarge],
    [{ ...shard, reason: "per_ip" }, m.rejectedPerIp],
  ]);
  metric("bivy_relay_evicted_slow_total", "Sockets evicted by slow-consumer backpressure since start.", "counter", [[shard, m.evictedSlow]]);

  const mem = process.memoryUsage();
  metric("bivy_relay_resident_memory_bytes", "Resident set size in bytes.", "gauge", [[shard, mem.rss]]);
  metric("bivy_relay_heap_used_bytes", "V8 heap used in bytes.", "gauge", [[shard, mem.heapUsed]]);
  metric("bivy_relay_uptime_seconds", "Process uptime in seconds.", "gauge", [[shard, Math.round(process.uptime())]]);

  return out.join("\n") + "\n";
}

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
