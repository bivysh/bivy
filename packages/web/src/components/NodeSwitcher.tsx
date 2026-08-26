// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../store/useStore.js";
import { controller } from "../store/useStore.js";
import { AddNodeSheet } from "./AddNodeSheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { Spinner } from "./Spinner.js";
import { StatusDot } from "./StatusDot.js";
import { Badge } from "./Badge.js";
import { useModalEscape } from "../modalStack.js";
import { EPHEMERAL_MACHINES_ENABLED } from "../flags.js";
import { ephemeralCatalogEntry, type EphemeralNodeConfig, type HostedMachineSummary } from "@bivy/core";

/**
 * Header control (relay mode): shows the current node and a menu to switch nodes,
 * spin up an ephemeral machine, or sign out. Hidden in direct/local mode where
 * there is only one node.
 */
export function NodeSwitcher() {
  const { connection: { nodes, currentNodeId, status }, activeSession: { activeSessionId }, sessionIndex: { sessions }, draft } = useAppState();
  const [open, setOpen] = useState(false);
  const [ephemeralConfigs, setEphemeralConfigs] = useState<EphemeralNodeConfig[]>([]);
  const [hostedMachines, setHostedMachines] = useState<HostedMachineSummary[]>([]);
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
      controller.listEphemeralConfigs()
        .then((configs) => setEphemeralConfigs(configs.filter((config) => Boolean(ephemeralCatalogEntry(config.provider)))))
        .catch(() => {});
      controller.listHostedMachines().then(setHostedMachines).catch(() => {});
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
  const pendingNodeName = activeSession?.pendingLaunch ? activeSession.pendingNodeName : undefined;
  // A runner picked for the (not-yet-created) draft session shows as the current
  // selection — offline/pending until the first message launches it.
  const draftRunner = !activeSessionId ? draft.ephemeralConfig : null;
  const concreteName = current?.name?.replace(/^Hosted\s+/i, "") || sessionNodeId || "Machine";
  const label = draftRunner ? draftRunner.name : pendingNodeName || (current?.id.startsWith("eph-") ? `${concreteName} — running` : concreteName);
  const showOnline = draftRunner ? false : current?.online;
  // Ephemeral machines enroll as real account nodes (id `eph-…`) once they boot,
  // so they'd otherwise show up twice: here under "Your nodes" AND under the
  // ephemeral section for their configured setup. Keep them out of the
  // persistent list — the ephemeral section is their only home. Applies to every
  // provider (Fly/Hetzner/AWS), which all mint `eph-` node ids at launch.
  const persistentNodes = nodes.filter((n) => !n.id.startsWith("eph-"));
  // Profiles are reusable templates: every selection launches a fresh Machine.
  // Running managed Machines are listed separately below as an explicit reuse
  // choice, so a template is never disabled merely because it already launched.
  const runningCloudMachines = useMemo(() => hostedMachines.filter((machine) =>
    machine.purpose === "interactive" && machine.desiredState !== "deleted" && machine.nodeId && nodes.some((node) => node.id === machine.nodeId),
  ), [hostedMachines, nodes]);
  const runningLabel = (machine: HostedMachineSummary) => {
    const profile = ephemeralConfigs.find((config) => config.id === machine.setupId);
    const name = (profile?.name || machine.name || "Bivy Cloud").replace(/^Hosted\s+/i, "");
    const createdAt = Date.parse(machine.createdAt);
    if (!machine.ttlMinutes || !Number.isFinite(createdAt)) return `${name} — running`;
    const remaining = Math.max(0, Math.ceil((createdAt + machine.ttlMinutes * 60_000 - Date.now()) / 60_000));
    return `${name} — running · ${remaining} min remaining`;
  };
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
        aria-label={locked ? `Session machine: ${label}` : undefined}
      >
        {/* Online/offline/reconnecting is otherwise color/shape-only (a 9px
            dot, sometimes a spinner) with no text — invisible to screen
            readers and easy to miss for colorblind users. */}
        {reconnecting
          ? <><Spinner size="xs" /><span className="sr-only">Reconnecting — </span></>
          : <StatusDot status={showOnline ? "online" : "idle"} label={`${showOnline ? "Online" : "Offline"} — `} />}
        <span className="node-switcher-name">{label}</span>
        {!locked && <span className="node-switcher-caret">▾</span>}
      </button>
      {open && !locked && (
        <div className="menu node-menu" role="menu">
          {reconnecting && (
            <div className="node-menu-status" role="status">
              <Spinner size="xs" />
              Reconnecting…
            </div>
          )}
          <div className="node-menu-head">Your machines</div>
          {persistentNodes.length === 0 && <div className="node-menu-empty">No other machines</div>}
          {persistentNodes.map((n) => (
            <div className="node-menu-row" key={n.id}>
              <button
                className={`menu-item node-menu-item${n.id === currentNodeId ? " active" : ""}`}
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  controller.switchNode(n.id);
                }}
              >
                <StatusDot status={n.online ? "online" : "idle"} label={`${n.online ? "Online" : "Offline"} — `} />
                <span className="node-menu-name">{n.name || n.id}</span>
                {n.id === currentNodeId && <span className="node-menu-check">✓</span>}
              </button>
            </div>
          ))}
          {EPHEMERAL_MACHINES_ENABLED && runningCloudMachines.length > 0 && (
            <>
              <div className="node-menu-head">Running Cloud machines</div>
              {runningCloudMachines.map((machine) => {
                const node = nodes.find((candidate) => candidate.id === machine.nodeId);
                return (
                  <button
                    key={machine.id}
                    className={`menu-item node-menu-item${machine.nodeId === currentNodeId && !draftRunner ? " active" : ""}`}
                    role="menuitem"
                    onClick={() => {
                      if (!machine.nodeId) return;
                      setOpen(false);
                      controller.switchNode(machine.nodeId);
                    }}
                  >
                    <StatusDot status={node?.online ? "online" : "idle"} label={`${node?.online ? "Online" : "Offline"} — `} />
                    <span className="node-menu-name">{runningLabel(machine)}</span>
                    {machine.nodeId === currentNodeId && !draftRunner && <span className="node-menu-check">✓</span>}
                  </button>
                );
              })}
            </>
          )}
          {EPHEMERAL_MACHINES_ENABLED && ephemeralConfigs.length > 0 && (
            <>
              <div className="node-menu-head">Start a new Cloud machine</div>
              {ephemeralConfigs.map((config) => {
                const picked = config.id === draftRunner?.id;
                const name = config.computeSource === "managed" ? `Start a new ${config.name} Machine` : config.name;
                return (
                  <button
                    key={config.id}
                    className={`menu-item node-menu-item${picked ? " active" : ""}`}
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      controller.pickDraftEphemeralRunner(config);
                    }}
                  >
                    <StatusDot status="idle" label={picked ? "Selected — " : "Available — "} />
                    <span className="node-menu-name">{name}</span>
                    <Badge>{config.provider}</Badge>
                    {picked && <span className="node-menu-check">✓</span>}
                  </button>
                );
              })}
            </>
          )}
          <div className="node-menu-sep" />
          <button
            className="menu-item node-menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setAddNodeOpen(true);
            }}
          >
            <span className="node-menu-glyph">+</span>
            <span className="node-menu-name">Add a machine…</span>
          </button>
          <div className="node-menu-sep" />
          {/* Confirm first — signing out here used to be a single tap with no
              undo (it drops the session and returns to the sign-in screen),
              while the identical action in Settings already confirms. */}
          <button className="menu-item node-menu-item danger" role="menuitem" onClick={() => { setOpen(false); setConfirmSignOut(true); }}>
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
      {addNodeOpen && <AddNodeSheet onClose={() => setAddNodeOpen(false)} />}
    </div>
  );
}
