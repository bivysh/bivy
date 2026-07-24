// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import { useAppState } from "../store/useStore.js";
import { controller } from "../store/useStore.js";
import { Sheet } from "./Sheet.js";
import { OauthStep } from "./ProviderConnect.js";

/**
 * Reconnect a SPECIFIC node's provider OAuth login from NodeSwitcher, without
 * requiring the user to manually switch to it first. Only ever opened while
 * NodeSwitcher's dropdown is reachable — i.e. no session is pinned to another
 * node (see NodeSwitcher's `locked` guard) — so `switchNode()`'s unconditional
 * `resetSession()` has no active session view to disrupt here.
 *
 * Sequence: connect to the target node (switching + waiting online only if it
 * isn't already the current, online node — see `controller.connectToNode`),
 * kick off OAuth for the given provider, then hand off to the shared
 * `OauthStep`. On close, restores whichever node was current before this
 * sheet opened (unless it's the same node), so fixing node B's login doesn't
 * silently leave node B as the new default node.
 */
export function NodeReconnectSheet({
  nodeId,
  providerId,
  nodeName,
  onClose,
}: {
  nodeId: string;
  providerId: string;
  nodeName: string;
  onClose: () => void;
}) {
  const state = useAppState();
  const [phase, setPhase] = useState<"connecting" | "ready" | "error">("connecting");
  const [error, setError] = useState("");
  // Captured once, on mount — the node the user was on before opening this
  // sheet, so `close()` can put them back rather than leaving `nodeId` as the
  // new default just because they stopped by to fix its login.
  const previousNodeId = useRef(state.currentNodeId);

  useEffect(() => {
    let cancelled = false;
    const connect = () => {
      setPhase("connecting");
      setError("");
      controller
        .connectToNode(nodeId)
        .then(() => {
          if (cancelled) return;
          setPhase("ready");
          controller.startOauth(providerId);
        })
        .catch((err) => {
          if (cancelled) return;
          setPhase("error");
          setError(err instanceof Error ? err.message : String(err));
        });
    };
    connect();
    return () => {
      cancelled = true;
    };
  }, [nodeId, providerId]);

  const provider = state.providers.find((p) => p.id === providerId);
  const providerName = provider?.name || providerId;

  function retry() {
    setPhase("connecting");
    setError("");
    controller
      .connectToNode(nodeId)
      .then(() => {
        setPhase("ready");
        controller.startOauth(providerId);
      })
      .catch((err) => {
        setPhase("error");
        setError(err instanceof Error ? err.message : String(err));
      });
  }

  function close() {
    const prior = previousNodeId.current;
    if (prior && prior !== nodeId) controller.switchNode(prior);
    onClose();
  }

  return (
    <Sheet title={`Reconnect ${providerName} on ${nodeName}`} onClose={close}>
      <div className="settings-form">
        {phase === "connecting" && <p className="muted">Connecting to {nodeName}…</p>}
        {phase === "error" && (
          <>
            <div className="banner error inline">{error || `Could not connect to ${nodeName}.`}</div>
            <button className="btn primary" onClick={retry}>
              Retry
            </button>
          </>
        )}
        {phase === "ready" && (state.oauth ? <OauthStep /> : <p className="muted">Starting sign-in…</p>)}
      </div>
    </Sheet>
  );
}
