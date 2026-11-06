// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import { fetchMe, fetchTeam, type TeamMemberView } from "@bivy/core";
import { controller } from "../store/useStore.js";
import type { SessionInviteView } from "../store/controller.js";
import { PickerItem, Sheet } from "./Sheet.js";

const formatDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Session menu → Invite a teammate: let one teammate into this session, and
 * nothing else on this machine, for a day or a week. Their devices get a key
 * for this session only (src/session-invites.ts on the machine).
 */
export function InviteTeammateSheet({ sessionId, name, onClose }: { sessionId: string; name: string; onClose: () => void }) {
  const [members, setMembers] = useState<TeamMemberView[] | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [invites, setInvites] = useState<SessionInviteView[]>([]);
  const [accountId, setAccountId] = useState("");
  const [mode, setMode] = useState<"prompt" | "view">("prompt");
  const [duration, setDuration] = useState<"day" | "week">("week");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([fetchTeam(controller.local), fetchMe(controller.local)]).then(([view, me]) => {
      if (!view.team) { setMembers([]); return; }
      setTeamName(view.team.name);
      const others = view.members.filter((m) => m.accountId !== me.account?.id);
      setMembers(others);
      if (others[0]) setAccountId(others[0].accountId);
    }, (e) => setError(String((e as Error)?.message || e)));
    controller.listSessionInvites(sessionId).then(setInvites, (e) => setError(String((e as Error)?.message || e)));
  }, [sessionId]);

  const run = async (fn: () => Promise<SessionInviteView[]>) => {
    setBusy(true);
    setError(null);
    try { setInvites(await fn()); } catch (e) { setError(String((e as Error)?.message || e)); } finally { setBusy(false); }
  };
  const member = members?.find((m) => m.accountId === accountId);

  return (
    <Sheet title="Invite a teammate" onClose={onClose} autoFocusSearch={false}>
      <div className="settings-form">
        <p className="muted small">
          Let a teammate into “{name}” only. They can't see your other sessions, files outside the chat, terminals or settings on this
          machine. Usage counts as yours.
        </p>
        {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
        {members === null ? (
          <p className="muted">Loading your team…</p>
        ) : members.length === 0 ? (
          <div className="vault-empty">
            <h4>{teamName ? "No one else in your team yet" : "You're not in a team"}</h4>
            <p className="muted small">{teamName ? "Invite people in Settings → Team first." : "Start a team in Settings → Team to invite people."}</p>
          </div>
        ) : (
          <form className="settings-section" onSubmit={(e) => {
            e.preventDefault();
            if (!member) return;
            void run(() => controller.createSessionInvite({ sessionId, accountId: member.accountId, email: member.email, mode, duration }));
          }}>
            <label className="field-label" htmlFor="invite-member">Teammate</label>
            <select id="invite-member" className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {members.map((m) => <option key={m.accountId} value={m.accountId}>{m.email}</option>)}
            </select>
            <div className="field-row">
              <select className="field" value={mode} aria-label="Access" onChange={(e) => setMode(e.target.value as "prompt" | "view")}>
                <option value="prompt">Can prompt and approve</option>
                <option value="view">Can only view</option>
              </select>
              <select className="field" value={duration} aria-label="For how long" onChange={(e) => setDuration(e.target.value as "day" | "week")}>
                <option value="day">For 1 day</option>
                <option value="week">For 7 days</option>
              </select>
              <button type="submit" className="btn primary" disabled={busy || !member}>{busy ? "Inviting…" : "Invite"}</button>
            </div>
            <p className="muted small">They'll find this machine under “Shared with you” in their machine menu.</p>
          </form>
        )}
        {invites.length > 0 && (
          <section className="settings-section">
            <h4 className="settings-subhead">In this session</h4>
            <div className="picker-list">
              {invites.map((invite) => (
                <PickerItem
                  key={invite.id}
                  title={invite.email}
                  meta={`${invite.mode === "view" ? "Can view" : "Can prompt"} · until ${formatDate(invite.expiresAt)}`}
                  right={
                    <button type="button" className="btn sm danger-ghost" disabled={busy}
                      onClick={() => void run(() => controller.revokeSessionInvite(sessionId, invite.id))}>
                      Remove
                    </button>
                  }
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </Sheet>
  );
}
