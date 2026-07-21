// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useMemo, useState } from "react";
import type { ModelInfo } from "@bivy/core";
import { controller, useAppState } from "../store/useStore.js";
import { Sheet, PickerItem } from "./Sheet.js";

/**
 * Fork a session (docs/session-fork-plan.md): continue it in a new session on
 * another node, agent, and/or model. One sheet, two finalizers — **copy** keeps
 * the original, **move** retires it once the destination confirms. The copy/move
 * default is context-aware: move when the node changes, copy when it doesn't.
 */
export function ForkSheet({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { nodes, currentNodeId, runtimes, models, currentModel, selectedAgentId } = useAppState();

  const [destNodeId, setDestNodeId] = useState<string>(currentNodeId ?? "");
  const [agentId, setAgentId] = useState<string | null>(selectedAgentId);
  const [model, setModel] = useState<ModelInfo | null>(currentModel);
  const [retireTouched, setRetireTouched] = useState(false);
  const [retire, setRetire] = useState(false);
  const [status, setStatus] = useState<"idle" | "working" | "error" | "warn">("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [warnings, setWarnings] = useState<Array<{ label?: string; detail?: string }>>([]);

  const crossNode = Boolean(currentNodeId) && destNodeId !== currentNodeId;
  // Context-aware default until the user picks: move across nodes, copy in place.
  const willRetire = retireTouched ? retire : crossNode;
  // A model only round-trips within one agent; only offer it when the agent is
  // unchanged (a different agent resolves its own model on the destination).
  const agentUnchanged = !agentId || agentId === selectedAgentId;

  const nodeList = useMemo(() => {
    const rows = [...nodes];
    if (currentNodeId && !rows.some((n) => n.id === currentNodeId)) rows.unshift({ id: currentNodeId, name: "This node", online: true });
    return rows;
  }, [nodes, currentNodeId]);

  async function doFork() {
    setStatus("working");
    setErrorMsg("");
    try {
      const result = await controller.forkSession(sessionId, {
        destNodeId: crossNode ? destNodeId : undefined,
        agentId: agentId && agentId !== selectedAgentId ? agentId : undefined,
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
        <div className="picker-section">
          <div className="picker-section-label">Destination node</div>
          <div className="picker-list">
            {nodeList.map((n) => (
              <PickerItem
                key={n.id}
                active={n.id === destNodeId}
                title={n.name || n.id}
                meta={n.id === currentNodeId ? "current" : n.online ? "online" : "offline"}
                disabled={busy}
                onClick={() => {
                  setDestNodeId(n.id);
                  if (!retireTouched) setRetire(Boolean(currentNodeId) && n.id !== currentNodeId);
                }}
              />
            ))}
          </div>
        </div>
      )}

      <div className="picker-section">
        <div className="picker-section-label">Agent</div>
        <div className="picker-list">
          {runtimes.map((rt) => (
            <PickerItem
              key={rt.id}
              active={(agentId ?? selectedAgentId) === rt.id}
              title={rt.displayName || rt.name || rt.id}
              meta={rt.id === selectedAgentId ? "current" : undefined}
              disabled={busy}
              onClick={() => setAgentId(rt.id)}
            />
          ))}
        </div>
      </div>

      {agentUnchanged && models.length > 0 && (
        <div className="picker-section">
          <div className="picker-section-label">Model</div>
          <div className="picker-list">
            {models.map((m) => (
              <PickerItem
                key={`${m.provider}/${m.id}`}
                active={model?.id === m.id && model?.provider === m.provider}
                title={String(m.name || m.id)}
                disabled={busy}
                onClick={() => setModel(m)}
              />
            ))}
          </div>
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
          <button className="fork-submit" onClick={onClose}>Done</button>
        </div>
      ) : (
        <div className="picker-section">
          <button className="fork-submit" onClick={doFork} disabled={busy}>
            {busy ? "Forking…" : willRetire ? "Move session" : "Create fork"}
          </button>
        </div>
      )}
    </Sheet>
  );
}
