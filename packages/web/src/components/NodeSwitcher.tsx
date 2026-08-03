// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../store/useStore.js";
import { controller } from "../store/useStore.js";
import { EphemeralSheet } from "./Ephemeral.js";
import { AddNodeSheet } from "./AddNodeSheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { useModalEscape } from "../modalStack.js";
import { EPHEMERAL_MACHINES_ENABLED } from "../flags.js";
import type { EphemeralNodeConfig, EphemeralMachine } from "@bivy/core";

/**
 * Header control (relay mode): shows the current node and a menu to switch nodes,
 * spin up an ephemeral machine, or sign out. Hidden in direct/local mode where
 * there is only one node.
 */
export function NodeSwitcher() {
  const { nodes, currentNodeId, status, activeSessionId, sessions } = useAppState();
  const [open, setOpen] = useState(false);
  const [ephemeralOpen, setEphemeralOpen] = useState(false);
  const [ephemeralConfig, setEphemeralConfig] = useState<EphemeralNodeConfig | undefined>();
  const [ephemeralConfigs, setEphemeralConfigs] = useState<EphemeralNodeConfig[]>([]);
  const [ephemeralMachines, setEphemeralMachines] = useState<EphemeralMachine[]>([]);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Escape closes the open menu (topmost-layer coordinated), matching every
  // other popover in the app.
  useModalEscape(() => setOpen(false), open);
  // A transient connection blip (reconnecting) or the very first connect used to
  // drop a full-width "Reconnecting…" banner into the layout, shoving the page
  // down on every mobile network hiccup. Instead the status indicator (the node
  // dot) turns into a small spinner, and the dropdown spells out "Reconnecting…"
  // under the node — no reflow of the transcript.
  const reconnecting = status === "reconnecting" || status === "connecting";

  useEffect(() => {
    if (!open) return;
    if (EPHEMERAL_MACHINES_ENABLED) {
      controller.listEphemeralConfigs().then(setEphemeralConfigs).catch(() => {});
      controller.listEphemeralMachines().then(setEphemeralMachines).catch(() => {});
    }
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
  // Ephemeral machines enroll as real account nodes (id `eph-…`) once they boot,
  // so they'd otherwise show up twice: here under "Your nodes" AND under the
  // ephemeral section for their configured setup. Keep them out of the
  // persistent list — the ephemeral section is their only home. Applies to every
  // provider (Fly/Hetzner/AWS), which all mint `eph-` node ids at launch.
  const persistentNodes = nodes.filter((n) => !n.id.startsWith("eph-"));
  // An ephemeral config is a node *template*: picking it for a new session
  // launches a fresh machine bound to that session. A config whose machine is
  // already initialized and owned by a session is "in use" and unavailable to
  // another session until that machine is torn down — one machine per session,
  // so a running machine is never offered to a second session. Reconnecting to a
  // running ephemeral session happens from the session list, not here.
  const sessionBoundNodeIds = useMemo(
    () => new Set(sessions.map((s) => s.nodeId).filter((id): id is string => Boolean(id))),
    [sessions],
  );
  const configInUse = (setupId: string) =>
    ephemeralMachines.some((m) => m.setupId === setupId && m.nodeId && sessionBoundNodeIds.has(m.nodeId));
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
          {persistentNodes.length === 0 && <div className="node-menu-empty">No other nodes</div>}
          {persistentNodes.map((n) => (
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
            </div>
          ))}
          {EPHEMERAL_MACHINES_ENABLED && ephemeralConfigs.length > 0 && (
            <>
              <div className="node-menu-head">Ephemeral machines</div>
              {ephemeralConfigs.map((config) => {
                // Each config is a node template. Picking it here launches a
                // fresh machine bound to the new session; if its machine is
                // already initialized and owned by a session, the config is "in
                // use" and can't be selected for another session.
                const inUse = configInUse(config.id);
                return (
                  <button
                    key={config.id}
                    className="node-menu-item"
                    role="menuitem"
                    disabled={inUse}
                    title={inUse ? "In use by another session — a config runs one machine per session" : undefined}
                    onClick={() => {
                      if (inUse) return;
                      setOpen(false);
                      setEphemeralConfig(config);
                      setEphemeralOpen(true);
                    }}
                  >
                    <span className="node-dot" aria-hidden />
                    <span className="sr-only">{inUse ? "In use — " : "Available — "}</span>
                    <span className="node-menu-name">{config.name}</span>
                    {inUse
                      ? <span className="chip" title="This config's machine belongs to another session">In use</span>
                      : <span className="chip">{config.provider}</span>}
                  </button>
                );
              })}
            </>
          )}
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
          <div className="node-menu-sep" />
          {/* Confirm first — signing out here used to be a single tap with no
              undo (it drops the session and returns to the sign-in screen),
              while the identical action in Settings already confirms. */}
          <button className="node-menu-item danger" role="menuitem" onClick={() => { setOpen(false); setConfirmSignOut(true); }}>
            Sign out
          </button>
        </div>
      )}
      {confirmSignOut && (
        <ConfirmDialog
          title="Sign out?"
          message="Sign out of Bivy on this device?"
          confirmLabel="Sign out"
          danger
          onCancel={() => setConfirmSignOut(false)}
          onConfirm={() => { setConfirmSignOut(false); controller.signOut(); }}
        />
      )}
      {ephemeralOpen && <EphemeralSheet config={ephemeralConfig} onClose={() => setEphemeralOpen(false)} />}
      {addNodeOpen && <AddNodeSheet onClose={() => setAddNodeOpen(false)} />}
    </div>
  );
}
