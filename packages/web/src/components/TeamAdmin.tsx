// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import { fetchTeamActivity, setTeamPolicies, type TeamActivityEvent, type TeamPolicies } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { PickerItem } from "./Sheet.js";
import { Toggle } from "./Toggle.js";

/** One row per policy: adding a policy is adding a row. */
const POLICY_ROWS: Array<{ key: keyof TeamPolicies; title: string; on: string; off: string }> = [
  {
    key: "shareMachines",
    title: "Members can share machines",
    on: "Members can let the team use one of their machines (Settings → Machines).",
    off: "No one can share a machine. Turning this off ends every share now.",
  },
  {
    key: "sessionInvites",
    title: "Members can invite teammates into a session",
    on: "Members can bring a teammate into one session for a day or a week.",
    off: "No one can invite teammates into sessions. Turning this off ends every invite now.",
  },
];

const formatWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** What an activity row says after its label: the content-free details. */
function describe(event: TeamActivityEvent): string {
  const d = event.detail;
  const parts = [
    typeof d.email === "string" && d.email ? d.email : "",
    typeof d.to === "string" ? (d.to === "link" ? "invite link" : d.to) : "",
    typeof d.role === "string" ? d.role : "",
    typeof d.machine === "string" ? d.machine : "",
    typeof d.name === "string" ? `“${d.name}”` : "",
    typeof d.open === "number" ? `${d.open} open` : "",
  ];
  if (event.action === "team.policies") {
    parts.push(`sharing ${d.shareMachines ? "on" : "off"}`, `session invites ${d.sessionInvites ? "on" : "off"}`);
  }
  return parts.filter(Boolean).join(" · ");
}

/** Settings → Team: team policies (admins change them, members see them) and
 *  the activity log (admins). */
export function TeamAdmin({ policies, admin, onChanged }: { policies: TeamPolicies; admin: boolean; onChanged: (next: TeamPolicies) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<TeamActivityEvent[] | null>(null);
  const loadActivity = () => { if (admin) fetchTeamActivity(controller.local).then((r) => setEvents(r.events), () => setEvents([])); };
  useEffect(loadActivity, [admin]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = async (patch: Partial<TeamPolicies>) => {
    setBusy(true);
    setError(null);
    try {
      onChanged((await setTeamPolicies(controller.local, patch)).policies);
      loadActivity();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="settings-section">
        <h4 className="settings-subhead">Policies</h4>
        {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
        {POLICY_ROWS.map((row) => (
          <div className="settings-toggle-row" key={row.key}>
            <div className="settings-toggle-text">
              <span className="settings-toggle-title">{row.title}</span>
              <span className="muted small">{policies[row.key] ? row.on : row.off}</span>
            </div>
            <Toggle checked={policies[row.key]} disabled={!admin || busy} onChange={(on) => void set({ [row.key]: on })} label={row.title} />
          </div>
        ))}
        {!admin && <p className="muted small">Only admins can change these.</p>}
      </section>
      {admin && (
        <section className="settings-section">
          <h4 className="settings-subhead">Activity</h4>
          <p className="muted small">Changes to who is in the team and what they can reach. Never what anyone works on: Bivy's servers don't have it.</p>
          <div className="picker-list">
            {events === null && <div className="picker-empty">Loading…</div>}
            {events?.length === 0 && <div className="picker-empty">Nothing yet.</div>}
            {events?.slice(0, 50).map((event) => (
              <PickerItem
                key={event.id}
                title={`${event.actorEmail}: ${event.label}`}
                meta={[describe(event), formatWhen(event.at)].filter(Boolean).join(" · ")}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
