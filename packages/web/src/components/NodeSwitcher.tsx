// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import { useAppState } from "../store/useStore.js";
import { controller } from "../store/useStore.js";
import { EphemeralSheet } from "./Ephemeral.js";
import { AddNodeSheet } from "./AddNodeSheet.js";
import { NodeReconnectSheet } from "./NodeReconnectSheet.js";

/** A node's provider connection chip: green when the stored OAuth token is
 *  still valid, amber when the credential exists but has expired. Providers
 *  never configured on that node aren't in `n.providers` at all (see
 *  pushProviderSummaryToControlPlane in src/server.ts), so there's nothing to
 *  render for them — this only ever shows providers the node has actually
 *  connected at some point. */
function providerChipState(expiresAt?: number): "ok" | "warn" {
  return typeof expiresAt === "number" && expiresAt < Date.now() ? "warn" : "ok";
}

/**
 * Header control (relay mode): shows the current node and a menu to switch nodes,
 * spin up an ephemeral machine, or sign out. Hidden in direct/local mode where
 * there is only one node.
 */
export function NodeSwitcher() {
  const { nodes, currentNodeId, status, activeSessionId, sessions } = useAppState();
  const [open, setOpen] = useState(false);
  const [ephemeralOpen, setEphemeralOpen] = useState(false);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [reconnectTarget, setReconnectTarget] = useState<{ nodeId: string; providerId: string; nodeName: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // A transient connection blip (reconnecting) or the very first connect used to
  // drop a full-width "Reconnecting…" banner into the layout, shoving the page
  // down on every mobile network hiccup. Instead the status indicator (the node
  // dot) turns into a small spinner, and the dropdown spells out "Reconnecting…"
  // under the node — no reflow of the transcript.
  const reconnecting = status === "reconnecting" || status === "connecting";

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);
  const sessionNodeId = activeSession?.nodeId || currentNodeId;
  const current = nodes.find((n) => n.id === sessionNodeId);
  const label = current?.name || sessionNodeId || "Node";
  // A draft may choose its node. Once the session exists, its owning node is
  // immutable: this control becomes a label rather than a global node switcher.
  const locked = Boolean(activeSessionId);

  return (
    <div className="node-switcher" ref={ref}>
      <button
        className={`node-switcher-btn${locked ? " locked" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          if (locked) return;
          if (nodes.length === 0) void controller.refreshNodes();
          setOpen((v) => !v);
        }}
        aria-haspopup={locked ? undefined : "menu"}
        aria-expanded={locked ? undefined : open}
        aria-label={locked ? `Session node: ${label}` : undefined}
      >
        {/* Online/offline/reconnecting is otherwise color/shape-only (a 9px
            dot, sometimes a spinner) with no text — invisible to screen
            readers and easy to miss for colorblind users. */}
        <span
          className={`node-dot${reconnecting ? " connecting" : current?.online ? " online" : ""}`}
          aria-hidden
        />
        <span className="sr-only">{reconnecting ? "Reconnecting" : current?.online ? "Online" : "Offline"} — </span>
        <span className="node-switcher-name">{label}</span>
        {!locked && <span className="node-switcher-caret">▾</span>}
      </button>
      {open && !locked && (
        <div className="node-menu" role="menu">
          {reconnecting && (
            <div className="node-menu-status" role="status">
              <span className="reconnect-spinner" aria-hidden />
              Reconnecting…
            </div>
          )}
          <div className="node-menu-head">Your nodes</div>
          {nodes.length === 0 && <div className="node-menu-empty">No other nodes</div>}
          {nodes.map((n) => (
            <div className="node-menu-row" key={n.id}>
              <button
                className={`node-menu-item${n.id === currentNodeId ? " active" : ""}`}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  controller.switchNode(n.id);
                }}
              >
                <span className={`node-dot${n.online ? " online" : ""}`} aria-hidden />
                <span className="sr-only">{n.online ? "Online" : "Offline"} — </span>
                <span className="node-menu-name">{n.name || n.id}</span>
                {n.id === currentNodeId && <span className="node-menu-check">✓</span>}
              </button>
              {(n.providers ?? []).map((p) => {
                const chipState = providerChipState(p.expiresAt);
                return (
                  <button
                    key={p.id}
                    className={`chip node-provider-chip${chipState === "ok" ? " ok" : " warn"}`}
                    title={chipState === "warn" ? `${p.name || p.id} login expired — reconnect` : `${p.name || p.id} connected`}
                    aria-label={`Reconnect ${p.name || p.id} on ${n.name || n.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(false);
                      setReconnectTarget({ nodeId: n.id, providerId: p.id, nodeName: n.name || n.id });
                    }}
                  >
                    {p.name || p.id}
                    {chipState === "warn" ? " · expired ↻" : ""}
                  </button>
                );
              })}
            </div>
          ))}
          <div className="node-menu-sep" />
          <button
            className="node-menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setAddNodeOpen(true);
            }}
          >
            <span className="node-menu-glyph">+</span>
            <span className="node-menu-name">Add a node…</span>
          </button>
          <button
            className="node-menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setEphemeralOpen(true);
            }}
          >
            <span className="node-menu-glyph">⚡</span>
            <span className="node-menu-name">Ephemeral machine…</span>
          </button>
          <div className="node-menu-sep" />
          <button className="node-menu-item danger" role="menuitem" onClick={() => controller.signOut()}>
            Sign out
          </button>
        </div>
      )}
      {ephemeralOpen && <EphemeralSheet onClose={() => setEphemeralOpen(false)} />}
      {addNodeOpen && <AddNodeSheet onClose={() => setAddNodeOpen(false)} />}
      {reconnectTarget && (
        <NodeReconnectSheet
          nodeId={reconnectTarget.nodeId}
          providerId={reconnectTarget.providerId}
          nodeName={reconnectTarget.nodeName}
          onClose={() => setReconnectTarget(null)}
        />
      )}
    </div>
  );
}
