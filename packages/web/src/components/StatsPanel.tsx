// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, type ReactNode } from "react";
import type { NodeStats, NodeStatsTier } from "@bivy/core";
import { useAppState, controller } from "../store/useStore.js";
import { Sheet } from "./Sheet.js";

function formatBytes(n: number | undefined | null): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatUptime(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

const pctText = (n: number | undefined | null): string =>
  typeof n === "number" && Number.isFinite(n) ? `${n < 10 ? n.toFixed(1) : Math.round(n)}%` : "—";

function level(pct: number | null | undefined): string {
  if (typeof pct !== "number") return "";
  return pct >= 90 ? " danger" : pct >= 75 ? " warn" : "";
}

/** A resource card: a headline bar for the node "used / total", then the
 *  session / Bivy / node breakdown rows. `barPct` drives the headline meter. */
function ResourceCard({
  title,
  barPct,
  barDetail,
  rows,
}: {
  title: string;
  barPct: number | null;
  barDetail: string;
  rows: { label: string; value: ReactNode; pct?: number | null }[];
}) {
  return (
    <section className="stat-card">
      <div className="stat-card-head">
        <span className="stat-card-title">{title}</span>
        <span className="stat-card-detail">{barDetail}</span>
      </div>
      <div className="stat-meter-track" role="progressbar" aria-valuenow={barPct ?? undefined} aria-valuemin={0} aria-valuemax={100} aria-label={title}>
        <div className={`stat-meter-fill${level(barPct)}`} style={{ width: `${barPct ?? 0}%` }} />
      </div>
      <dl className="stat-rows">
        {rows.map((r) => (
          <div className="stat-row" key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** "used · pct" for a byte tier; "—" when the tier is absent. */
function bytesTier(tier: NodeStatsTier | null | undefined, fallback = "—"): ReactNode {
  if (!tier) return <span className="stat-dim">{fallback}</span>;
  return (
    <>
      {formatBytes(tier.bytes)} <span className="stat-dim">· {pctText(tier.pct)}</span>
    </>
  );
}

function cpuTier(tier: NodeStatsTier | null | undefined, fallback = "—"): ReactNode {
  if (!tier) return <span className="stat-dim">{fallback}</span>;
  return pctText(tier.pct);
}

/**
 * "Node stats" panel — live memory / CPU / storage for the machine backing the
 * current session, each broken down three ways: this session, all of Bivy, and
 * the node total (available). Opened from the header ⋯ menu; polls every 2s.
 *
 * Honesty notes surfaced in the UI: agents run as per-turn subprocesses, so a
 * session's live figure is non-zero only while a turn is running — and only for
 * runtimes with a separable process (Pi runs in-process; Claude Code's process
 * lives inside its SDK, so it's counted under Bivy, not the session).
 */
export function StatsPanel({ onClose }: { onClose: () => void }) {
  const { settings: { nodeStats }, connection: { status }, activeSession: { activeSessionId } } = useAppState();
  const online = status === "online" || status === "reconnecting";

  useEffect(() => {
    const poll = () => controller.requestNodeStats(activeSessionId ?? undefined);
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [activeSessionId]);

  const s: NodeStats | null = nodeStats;
  const sessionIdle = s && !s.sessionMeasurable ? "idle / in-process" : "—";

  return (
    <Sheet title="Machine stats" onClose={onClose} autoFocusSearch={false}>
      <div className="stats-panel">
        {!s && <div className="stats-empty">{online ? "Loading machine stats…" : "Machine offline — stats unavailable."}</div>}

        {s?.memory && (
          <ResourceCard
            title="Memory"
            barPct={s.memory.node.usedPct}
            barDetail={`${formatBytes(s.memory.node.used)} / ${formatBytes(s.memory.node.total)}`}
            rows={[
              { label: "This session", value: bytesTier(s.memory.session, sessionIdle), pct: s.memory.session?.pct },
              { label: "All of Bivy", value: bytesTier(s.memory.bivy), pct: s.memory.bivy.pct },
              { label: "Machine used", value: <>{formatBytes(s.memory.node.used)} <span className="stat-dim">· {pctText(s.memory.node.usedPct)}</span></> },
              { label: "Machine free", value: <span className="stat-dim">{formatBytes(s.memory.node.free)} available</span> },
            ]}
          />
        )}

        {s?.cpu && (
          <ResourceCard
            title="CPU"
            barPct={s.cpu.node.usedPct}
            barDetail={`${s.cores ?? "?"} core${s.cores === 1 ? "" : "s"} · ${pctText(s.cpu.node.usedPct)} busy`}
            rows={[
              { label: "This session", value: cpuTier(s.cpu.session, sessionIdle), pct: s.cpu.session?.pct },
              { label: "All of Bivy", value: cpuTier(s.cpu.bivy), pct: s.cpu.bivy.pct },
              { label: "Machine total", value: <>{pctText(s.cpu.node.usedPct)} <span className="stat-dim">busy</span></> },
            ]}
          />
        )}

        {s?.storage && (
          <ResourceCard
            title="Storage"
            barPct={s.storage.node?.usedPct ?? null}
            barDetail={s.storage.node ? `${formatBytes(s.storage.node.used)} / ${formatBytes(s.storage.node.total)}` : "unavailable"}
            rows={[
              { label: "This session", value: bytesTier(s.storage.session, s.storage.session === null ? "measuring…" : "—"), pct: s.storage.session?.pct },
              { label: "All of Bivy", value: bytesTier(s.storage.bivy, "measuring…"), pct: s.storage.bivy?.pct },
              ...(s.storage.node
                ? [
                    { label: "Machine used", value: <>{formatBytes(s.storage.node.used)} <span className="stat-dim">· {pctText(s.storage.node.usedPct)}</span></> as ReactNode },
                    { label: "Machine free", value: <span className="stat-dim">{formatBytes(s.storage.node.free)} available</span> as ReactNode },
                  ]
                : []),
            ]}
          />
        )}

        {s && (
          <>
            <dl className="stats-meta">
              {s.name && (
                <div className="stats-meta-row">
                  <dt>Machine</dt>
                  <dd>{s.name}</dd>
                </div>
              )}
              {s.load && (
                <div className="stats-meta-row">
                  <dt>Load avg</dt>
                  <dd>{s.load.map((n) => n.toFixed(2)).join("  ")}</dd>
                </div>
              )}
              {s.cpuModel && (
                <div className="stats-meta-row">
                  <dt>CPU</dt>
                  <dd>{s.cpuModel}</dd>
                </div>
              )}
              {s.uptime != null && (
                <div className="stats-meta-row">
                  <dt>Uptime</dt>
                  <dd>{formatUptime(s.uptime)}</dd>
                </div>
              )}
            </dl>
            <p className="stats-note">
              Percentages are of the node total. A session runs its agent as a per-turn subprocess, so its live figure
              is non-zero only while a turn is running (and only for agents with a separate process — otherwise the work
              is counted under “All of Bivy”). Updates every 2&nbsp;seconds.
            </p>
          </>
        )}
      </div>
    </Sheet>
  );
}
