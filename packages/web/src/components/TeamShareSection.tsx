// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { useState } from "react";
import type { AppState } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { ConfirmDialog } from "./AppDialog.js";
import { PickerItem } from "./Sheet.js";
import { Toggle } from "./Toggle.js";

/**
 * Settings → Machines → Share with team, for the connected machine. The switch
 * is the machine's own: until it is on there, the machine refuses teammates
 * even when the control plane vouches for them. Turning it on asks first,
 * because a teammate gets everything the owner has on this machine.
 */
export function TeamShareSection({ state }: { state: AppState }) {
  const online = state.connection.status === "online";
  const share = online ? state.settings.nodeSettings?.teamShare : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOn, setConfirmOn] = useState(false);
  if (!share) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const team = share.teamName;
  return (
    <section className="settings-section">
      <h4 className="settings-subhead">Team</h4>
      {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
      <div className="settings-toggle-row">
        <div className="settings-toggle-text">
          <span className="settings-toggle-title">Share with {team ?? "your team"}</span>
          <span className="muted small">
            {team
              ? "Teammates can connect to this machine and use it as you do: sessions, terminals, files and the sign-ins on it. Usage counts as yours."
              : "Join or start a team in Settings → Team to share this machine."}
          </span>
        </div>
        <Toggle
          checked={share.enabled}
          disabled={busy || (!team && !share.enabled)}
          onChange={(on) => (on ? setConfirmOn(true) : void run(() => controller.setNodeSettings({ teamShare: false })))}
          label={`Share this machine with ${team ?? "your team"}`}
        />
      </div>
      {share.teammateDevices.length > 0 && (
        <div className="picker-list">
          {share.teammateDevices.map((d) => (
            <PickerItem
              key={d.id}
              title={d.email || d.label}
              meta={d.label}
              right={
                <button type="button" className="btn sm danger-ghost" disabled={busy}
                  onClick={() => void run(() => controller.setNodeSettings({ teamShareRemoveDevice: d.id }))}>
                  Remove
                </button>
              }
            />
          ))}
        </div>
      )}
      {confirmOn && (
        <ConfirmDialog
          title={`Share this machine with ${team}?`}
          message="Everyone in the team can open sessions and terminals here, read and change files, and use the agent sign-ins on this machine. Turn it off at any time to remove their devices."
          confirmLabel="Share"
          onCancel={() => setConfirmOn(false)}
          onConfirm={() => { setConfirmOn(false); void run(() => controller.setNodeSettings({ teamShare: true })); }}
        />
      )}
    </section>
  );
}
