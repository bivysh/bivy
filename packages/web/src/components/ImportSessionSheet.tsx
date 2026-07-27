// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useMemo, useState } from "react";
import { controller, useAppState } from "../store/useStore.js";
import { Sheet, PickerItem } from "./Sheet.js";
import type { DiscoveredNativeSessionDto } from "../store/controller.js";

/** Last path segment of a cwd as a readable "repository" label — the same
 *  best-effort heuristic used for filtering/grouping, not a git lookup. */
function repoOf(cwd?: string): string {
  if (!cwd) return "";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function relTime(ms?: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

const ALL = "__all__";

/**
 * Discover and adopt provider-native sessions (issue #156) — a bare `claude` or
 * `codex` session started outside Bivy, on this node or another one. Purely
 * capability-driven: the node only reports sessions from a runtime that
 * advertised discovery, and only offers an adopt action when the runtime also
 * advertised adoption AND the session isn't seen as still-live elsewhere
 * (see planNativeAdoption on the node) — so an unsupported provider, or a
 * session with a live external process, never shows a misleading action here.
 */
export function ImportSessionSheet({ onClose }: { onClose: () => void }) {
  const { nodes, currentNodeId } = useAppState();

  const [nodeId, setNodeId] = useState(currentNodeId ?? "");
  const [providerFilter, setProviderFilter] = useState(ALL);
  const [repoFilter, setRepoFilter] = useState(ALL);
  const [sessions, setSessions] = useState<DiscoveredNativeSessionDto[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [importingRef, setImportingRef] = useState<string | null>(null);
  const [importError, setImportError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setStatus("loading");
      setLoadError("");
      try {
        // Node filter: switching nodes to browse another one's sessions reuses
        // the same "dial that node first" pattern NodeSwitcher/promoteSession
        // already use for a one-off cross-node action.
        if (nodeId && nodeId !== currentNodeId) await controller.connectToNode(nodeId);
        const result = await controller.discoverNativeSessions();
        if (!cancelled) {
          setSessions(result);
          setStatus("ready");
        }
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // Only re-run when the browsed node changes — not on every currentNodeId
    // tick, which would refire while `connectToNode` above is still switching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const providers = useMemo(() => [...new Set(sessions.map((s) => s.agentName))].sort(), [sessions]);
  const repos = useMemo(() => [...new Set(sessions.map((s) => repoOf(s.cwd)).filter(Boolean))].sort(), [sessions]);

  const filtered = useMemo(
    () =>
      sessions
        .filter((s) => providerFilter === ALL || s.agentName === providerFilter)
        .filter((s) => repoFilter === ALL || repoOf(s.cwd) === repoFilter)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    [sessions, providerFilter, repoFilter],
  );

  async function doImport(session: DiscoveredNativeSessionDto) {
    setImportingRef(session.ref);
    setImportError("");
    try {
      await controller.importNativeSession(session.runtimeId, session.ref);
      onClose();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportingRef(null);
    }
  }

  const nodeList = useMemo(() => {
    const rows = [...nodes];
    if (currentNodeId && !rows.some((n) => n.id === currentNodeId)) rows.unshift({ id: currentNodeId, name: "This node", online: true });
    return rows;
  }, [nodes, currentNodeId]);

  return (
    <Sheet title="Import existing session" onClose={onClose} autoFocusSearch={false}>
      {nodeList.length > 1 && (
        <div className="picker-section">
          <div className="picker-section-label">Node</div>
          <div className="picker-list">
            {nodeList.map((n) => (
              <PickerItem
                key={n.id}
                active={n.id === nodeId}
                title={n.name || n.id}
                meta={n.id === currentNodeId ? "current" : n.online ? "online" : "offline"}
                onClick={() => setNodeId(n.id)}
              />
            ))}
          </div>
        </div>
      )}

      {providers.length > 1 && (
        <div className="picker-section">
          <div className="picker-section-label">Provider</div>
          <div className="picker-list">
            <PickerItem active={providerFilter === ALL} title="All providers" onClick={() => setProviderFilter(ALL)} />
            {providers.map((p) => (
              <PickerItem key={p} active={providerFilter === p} title={p} onClick={() => setProviderFilter(p)} />
            ))}
          </div>
        </div>
      )}

      {repos.length > 1 && (
        <div className="picker-section">
          <div className="picker-section-label">Repository</div>
          <div className="picker-list">
            <PickerItem active={repoFilter === ALL} title="All repositories" onClick={() => setRepoFilter(ALL)} />
            {repos.map((r) => (
              <PickerItem key={r} active={repoFilter === r} title={r} onClick={() => setRepoFilter(r)} />
            ))}
          </div>
        </div>
      )}

      <div className="picker-section">
        <div className="picker-section-label">Sessions (newest first)</div>
        {status === "loading" && <div className="import-session-hint">Looking for sessions this node can see…</div>}
        {status === "error" && <div className="fork-error" role="alert">{loadError}</div>}
        {status === "ready" && filtered.length === 0 && (
          <div className="import-session-hint">
            {sessions.length === 0
              ? "No importable sessions found — Bivy already manages everything this node can see, or no supported provider (Claude Code, Codex) has a session here."
              : "No sessions match these filters."}
          </div>
        )}
        <div className="picker-list">
          {filtered.map((s) => (
            <PickerItem
              key={`${s.runtimeId}:${s.ref}`}
              title={s.title || "Untitled session"}
              meta={`${s.agentName} · ${repoOf(s.cwd) || s.cwd || "unknown directory"} · ${relTime(s.updatedAt)}`}
              right={
                s.plan.mode === "follow-only" ? (
                  <span className="import-session-badge" title={s.plan.disclosure}>
                    Live elsewhere
                  </span>
                ) : (
                  <button
                    className="import-session-action"
                    disabled={importingRef === s.ref}
                    onClick={() => doImport(s)}
                    title={s.plan.disclosure}
                  >
                    {importingRef === s.ref ? "Importing…" : s.plan.mode === "seeded" ? "Import (seeded)" : "Adopt"}
                  </button>
                )
              }
            />
          ))}
        </div>
        {importError && <div className="fork-error" role="alert">{importError}</div>}
      </div>
    </Sheet>
  );
}
