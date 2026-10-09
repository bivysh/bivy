// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../store/useStore.js";
import { controller } from "../store/useStore.js";
import { AddNodeSheet } from "./AddNodeSheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { Spinner } from "./Spinner.js";
import { StatusDot } from "./StatusDot.js";
import { useModalEscape } from "../modalStack.js";
import { EPHEMERAL_MACHINES_ENABLED } from "../flags.js";
import type { EphemeralNodeConfig, HostedMachineSummary } from "@bivy/core";
import { cloudDestinations, nodePresence, PRESENCE, type CloudDestination } from "../cloudDestinations.js";
import type { TailnetMachine } from "../access.js";

/**
 * Header control (relay mode): shows the current node and a menu to switch nodes,
 * spin up an ephemeral machine, or sign out. Hidden in direct/local mode where
 * there is only one node.
 */
export function NodeSwitcher() {
  const { connection: { nodes, currentNodeId, status }, activeSession: { activeSessionId }, sessionIndex: { sessions }, draft } = useAppState();
  const cloudMachinesEnabled = EPHEMERAL_MACHINES_ENABLED;
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
    if (cloudMachinesEnabled) {
      controller.listEphemeralConfigs()
        .then(setEphemeralConfigs)
        .catch(() => {});
      controller.listHostedMachines().then(setHostedMachines).catch(() => {});
    }
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open, cloudMachinesEnabled]);

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);
  const sessionNodeId = activeSession?.nodeId || currentNodeId;
  const current = nodes.find((n) => n.id === sessionNodeId);
  const pendingNodeName = activeSession?.pendingLaunch ? activeSession.pendingNodeName : undefined;
  // A runner picked for the (not-yet-created) draft session shows as the current
  // selection — offline/pending until the first message launches it.
  const draftRunner = cloudMachinesEnabled && !activeSessionId ? draft.ephemeralConfig : null;
  const concreteName = current?.name?.replace(/^Hosted\s+/i, "") || sessionNodeId || "Machine";
  // Whether a cloud node is up is the status dot's job; the name stays the name.
  const label = draftRunner ? draftRunner.name : pendingNodeName || concreteName;
  const presence = draftRunner ? "offline" : nodePresence(current ?? (sessionNodeId ? { id: sessionNodeId } : undefined));
  // Ephemeral machines enroll as real account nodes (id `eph-…`) once they boot,
  // so they'd otherwise show up twice: here under "Your machines" AND as a cloud
  // row. Keep them out of the persistent list — the cloud section is their only
  // home. Applies to every provider, which all mint `eph-` node ids at launch.
  const persistentNodes = nodes.filter((n) => !n.id.startsWith("eph-"));
  const cloud = useMemo(() => cloudDestinations(ephemeralConfigs, hostedMachines, nodes), [ephemeralConfigs, hostedMachines, nodes]);
  const cloudRows = cloud;
  const isPicked = (row: CloudDestination) => draftRunner
    ? row.config.id === draftRunner.id
    : Boolean(row.nodeId) && row.nodeId === currentNodeId;
  const pickCloud = (row: CloudDestination) => {
    setOpen(false);
    // A running Machine is reused as-is; otherwise the profile launches one
    // when the first message is sent.
    if (row.nodeId) controller.switchNode(row.nodeId);
    else controller.pickDraftEphemeralRunner(row.config);
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
        aria-label={locked ? `Runs on ${label}` : undefined}
      >
        {/* Online/offline/reconnecting is otherwise color/shape-only (a 9px
            dot, sometimes a spinner) with no text — invisible to screen
            readers and easy to miss for colorblind users. */}
        {reconnecting
          ? <><Spinner size="xs" /><span className="sr-only">Reconnecting — </span></>
          : <StatusDot status={presence === "online" ? "online" : "idle"} label={`${PRESENCE[presence].label} — `} />}
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
          {cloudMachinesEnabled && cloudRows.length > 0 && (
            <>
              <div className="node-menu-head">Cloud</div>
              {cloudRows.map((row) => {
                const picked = isPicked(row);
                return (
                  <button
                    key={row.key}
                    className={`menu-item node-menu-item${picked ? " active" : ""}`}
                    role="menuitem"
                    onClick={() => pickCloud(row)}
                  >
                    <StatusDot status={row.online ? "online" : "idle"} label={row.online ? "Online — " : row.asleep ? "Asleep — " : "Not running — "} />
                    <span className="node-menu-name">{row.label}</span>
                    {!row.online && <span className="node-menu-meta">{row.asleep ? `asleep · ${PRESENCE.asleep.hint}` : "starts when you send"}</span>}
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
            <span className="node-menu-name">Add a Machine…</span>
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

/**
 * Header control when this machine serves the app over Tailscale: the machine
 * you're on, and the others on your tailnet running Bivy. Each has its own
 * address, so picking one opens it there; your own devices need no pairing.
 */
export function TailnetSwitcher() {
  const { connection: { status } } = useAppState();
  const [open, setOpen] = useState(false);
  const [machines, setMachines] = useState<TailnetMachine[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useModalEscape(() => setOpen(false), open);
  useEffect(() => {
    if (status !== "online") return;
    controller.listTailnetMachines().then(setMachines).catch(() => setMachines([]));
  }, [status, open]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);
  const self = machines?.find((m) => m.self);
  const others = machines?.filter((m) => !m.self) ?? [];
  const online = status === "online";
  return (
    <div className="node-switcher" ref={ref}>
      <button className="node-switcher-btn" aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
        <StatusDot status={online ? "online" : "idle"} label={`${online ? "Online" : "Offline"} — `} />
        <span className="node-switcher-name">{self?.name || location.hostname.split(".")[0]}</span>
        <span className="node-switcher-caret">▾</span>
      </button>
      {open && (
        <div className="menu node-menu" role="menu">
          <div className="node-menu-head">Your machines</div>
          {machines === null && <div className="node-menu-status" role="status"><Spinner size="xs" />Looking…</div>}
          {self && (
            <div className="node-menu-row">
              <span className="menu-item node-menu-item active" role="menuitem" aria-current="true">
                <StatusDot status="online" label="Online — " />
                <span className="node-menu-name">{self.name}</span>
                <span className="node-menu-check">✓</span>
              </span>
            </div>
          )}
          {others.map((m) => (
            <div className="node-menu-row" key={m.url}>
              <a className="menu-item node-menu-item" role="menuitem" href={m.url}>
                <StatusDot status="online" label="Online — " />
                <span className="node-menu-name">{m.name}</span>
              </a>
            </div>
          ))}
          {machines !== null && others.length === 0 && (
            <div className="node-menu-empty">No other machines yet. Run <code>bivy tailscale</code> on another machine and it shows up here.</div>
          )}
        </div>
      )}
    </div>
  );
}
