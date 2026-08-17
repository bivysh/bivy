// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useMemo, useState } from "react";
import type { ModelInfo } from "@bivy/core";
import { controller, useAppState } from "../store/useStore.js";
import { Sheet } from "./Sheet.js";

/** Stable select value for a model; provider + id together identify it. */
function modelKey(model: ModelInfo & { provider?: unknown }): string {
  return JSON.stringify([String(model.provider), String(model.id)]);
}

/**
 * Fork a session: continue it in a new session on another node, agent, and/or
 * model. One sheet, two finalizers — **copy** keeps the original, **move**
 * retires it once the destination confirms. The copy/move default is
 * context-aware: move when the node changes, copy when it doesn't.
 */
export function ForkSheet({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { connection: { nodes, currentNodeId }, catalogs: { runtimes, models, currentModel }, activeSession: { activeSessionId, activeRuntimeId }, sessionIndex: { sessions } } = useAppState();
  // selectedAgentId is the node/global draft preference, not the owner of an
  // existing session. Prefer the runtime from canonical history for the active
  // session, with its session-list row only as an early open-paint fallback.
  const sourceAgentId = activeSessionId === sessionId && activeRuntimeId
    ? activeRuntimeId
    : sessions.find((s) => s.sessionId === sessionId)?.runtimeId ?? null;

  const [destNodeId, setDestNodeId] = useState<string>(currentNodeId ?? "");
  const [agentId, setAgentId] = useState<string | null>(sourceAgentId);
  const [model, setModel] = useState<ModelInfo | null>(currentModel);
  const [retireTouched, setRetireTouched] = useState(false);
  const [retire, setRetire] = useState(false);
  const [status, setStatus] = useState<"idle" | "working" | "error" | "warn">("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [warnings, setWarnings] = useState<Array<{ label?: string; detail?: string }>>([]);

  // A sheet can open while canonical history is still arriving. Adopt the
  // session runtime once known, but never overwrite a choice the user made.
  useEffect(() => {
    if (agentId == null && sourceAgentId) setAgentId(sourceAgentId);
  }, [agentId, sourceAgentId]);

  const crossNode = Boolean(currentNodeId) && destNodeId !== currentNodeId;
  // Context-aware default until the user picks: move across nodes, copy in place.
  const willRetire = retireTouched ? retire : crossNode;
  // A model only round-trips within one agent; only offer it when the agent is
  // unchanged (a different agent resolves its own model on the destination).
  const agentUnchanged = !agentId || agentId === sourceAgentId;

  const nodeList = useMemo(() => {
    const rows = [...nodes];
    if (currentNodeId && !rows.some((n) => n.id === currentNodeId)) rows.unshift({ id: currentNodeId, name: "This machine", online: true });
    return rows;
  }, [nodes, currentNodeId]);

  async function doFork() {
    setStatus("working");
    setErrorMsg("");
    try {
      const result = await controller.forkSession(sessionId, {
        destNodeId: crossNode ? destNodeId : undefined,
        // Pass the selected target explicitly. The controller compares it with
        // the source session's runtime; treating this as only an "agent change"
        // made the target ambiguous and allowed forks to fall back to the source.
        agentId: agentId ?? undefined,
        sourceAgentId: sourceAgentId ?? undefined,
        model: agentUnchanged && model ? { provider: String(model.provider), id: String(model.id) } : undefined,
        retireSource: willRetire,
      });
      // The fork succeeded and its session is already open. If the destination
      // was missing a (non-blocking) prereq — a model login, GitHub access —
      // keep the sheet up to tell the user, otherwise just close.
      if (result.missing.length > 0) {
        setWarnings(result.missing);
        setStatus("warn");
      } else {
        onClose();
      }
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  const busy = status === "working";

  return (
    <Sheet title={willRetire ? "Move session" : "Fork session"} onClose={onClose} autoFocusSearch={false}>
      {nodeList.length > 1 && (
        <div className="picker-section fork-select-field">
          <label htmlFor="fork-destination-node">Destination machine</label>
          <select
            id="fork-destination-node"
            value={destNodeId}
            disabled={busy}
            onChange={(e) => {
              const id = e.target.value;
              setDestNodeId(id);
              if (!retireTouched) setRetire(Boolean(currentNodeId) && id !== currentNodeId);
            }}
          >
            {nodeList.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name || n.id} ({n.id === currentNodeId ? "current" : n.online ? "online" : "offline"})
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="picker-section fork-select-field">
        <label htmlFor="fork-agent">Agent</label>
        <select id="fork-agent" value={agentId ?? ""} disabled={busy} onChange={(e) => setAgentId(e.target.value)}>
          {runtimes.map((rt) => (
            <option key={rt.id} value={rt.id}>
              {rt.displayName || rt.name || rt.id}{rt.id === sourceAgentId ? " (current)" : ""}
            </option>
          ))}
        </select>
      </div>

      {agentUnchanged && models.length > 0 && (
        <div className="picker-section fork-select-field">
          <label htmlFor="fork-model">Model</label>
          <select
            id="fork-model"
            value={model ? modelKey(model) : ""}
            disabled={busy}
            onChange={(e) => {
              const selected = models.find((m) => modelKey(m) === e.target.value);
              if (selected) setModel(selected);
            }}
          >
            {models.map((m) => (
              <option key={modelKey(m)} value={modelKey(m)}>{String(m.name || m.id)}</option>
            ))}
          </select>
        </div>
      )}

      <div className="picker-section">
        <label className="fork-toggle">
          <input
            type="checkbox"
            checked={willRetire}
            disabled={busy}
            onChange={(e) => { setRetireTouched(true); setRetire(e.target.checked); }}
          />
          <span>Retire the original after moving (uncheck to keep both)</span>
        </label>
      </div>

      {status === "error" && <div className="fork-error" role="alert">{errorMsg}</div>}

      {status === "warn" ? (
        <div className="picker-section">
          <div className="picker-section-label">Fork created — finish setup on the destination</div>
          {warnings.map((w, i) => (
            <div key={i} className="fork-warn">{w.detail || w.label}</div>
          ))}
          <button className="btn primary fork-submit" onClick={onClose}>Done</button>
        </div>
      ) : (
        <div className="picker-section">
          <button className="btn primary fork-submit" onClick={doFork} disabled={busy}>
            {busy ? "Forking…" : willRetire ? "Move session" : "Create fork"}
          </button>
        </div>
      )}
    </Sheet>
  );
}
