// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";
import {
  createTeam, createTeamInvite, deleteTeam, fetchMe, fetchTeam, joinTeam, previewTeamInvite, removeTeamMember, renameTeam,
  revokeTeamInvite, setTeamMemberRole, TeamRequestError, type TeamInvitePreview, type TeamInviteView, type TeamRole, type TeamView,
} from "@bivy/core";
import type { AppState } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { TeamInstructions } from "./TeamInstructions.js";
import { TeamKeys } from "./TeamKeys.js";
import { TeamAdmin } from "./TeamAdmin.js";
import { PickerItem } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { Badge } from "./Badge.js";
import { writeClipboard } from "../clipboard.js";
import { clearTeamInvite, peekTeamInvite } from "../teamInvite.js";

type Confirm = { title: string; message: string; label: string; action: () => Promise<unknown> };

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
const roleLabel = (role: TeamRole) => (role === "admin" ? "Admin" : "Member");

function inviteMeta(invite: TeamInviteView): string {
  const uses = invite.email ? "" : ` · ${invite.uses} of ${invite.maxUses} used`;
  return `${roleLabel(invite.role)}${uses} · Expires ${formatDate(invite.expiresAt)}`;
}

/**
 * Settings → Team: who is in your team, their roles, and invites. The control
 * plane holds only this roster; members' sessions and machines stay their own.
 */
export function TeamPanel({ state }: { state: AppState }) {
  const local = controller.local;
  const [view, setView] = useState<TeamView | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [name, setName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<TeamRole>("member");
  const [link, setLink] = useState<string | null>(null);
  const [pendingToken, setPendingToken] = useState<string | null>(() => peekTeamInvite());
  const [pending, setPending] = useState<TeamInvitePreview | null>(null);

  const load = () => fetchTeam(local).then(setView).catch((e) => setError(
    e instanceof TeamRequestError && e.status === 401 ? "Sign in to your Bivy account to create or join a team." : String((e as Error).message || e),
  ));
  useEffect(() => {
    void load();
    fetchMe(local).then((me) => setMyId(me.account?.id ?? null)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on open; `local` is the controller's fixed store
  }, []);
  useEffect(() => {
    if (!pendingToken) return;
    previewTeamInvite(local, pendingToken).then(setPending).catch((e) => {
      clearTeamInvite();
      setPendingToken(null);
      setError(String((e as Error).message || e));
    });
  }, [pendingToken, local]);

  /** Run one roster change; the response is the new roster. */
  const run = async (id: string, fn: () => Promise<TeamView | unknown>, done?: string) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      const next = await fn();
      if (next && typeof next === "object" && "team" in next) setView(next as TeamView);
      else await load();
      if (done) setNotice(done);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(null);
    }
  };

  const dismissInvite = () => { clearTeamInvite(); setPendingToken(null); setPending(null); };
  const join = () => run("join", async () => {
    const next = await joinTeam(local, pendingToken!);
    dismissInvite();
    return next;
  }, pending ? `You joined ${pending.teamName}.` : undefined);

  const copyLink = (url: string) => { void writeClipboard(url).then(() => setNotice("Invite link copied.")).catch(() => {}); };

  const dialog = confirm && (
    <ConfirmDialog
      title={confirm.title}
      message={confirm.message}
      confirmLabel={confirm.label}
      danger
      onCancel={() => setConfirm(null)}
      onConfirm={() => { const c = confirm; setConfirm(null); void run("confirm", c.action); }}
    />
  );

  const banners = (
    <>
      {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
      {notice && <div className="banner inline" data-tone="ok" role="status">{notice}</div>}
      {pending && !pending.alreadyMember && (
        <section className="card" aria-labelledby="team-invite-title">
          <div className="card-head"><span className="card-title" id="team-invite-title">Join {pending.teamName}</span></div>
          <p className="card-sub">
            {pending.invitedBy ? `${pending.invitedBy} invited you` : "You're invited"} as {pending.role === "admin" ? "an admin" : "a member"}.
            {pending.inOtherTeam ? " You're already in a team; leave it first to join this one." : ""}
          </p>
          <div className="row-actions">
            <button type="button" className="btn primary" disabled={busy !== null || pending.inOtherTeam} onClick={join}>
              {busy === "join" ? "Joining…" : `Join ${pending.teamName}`}
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={dismissInvite}>Not now</button>
          </div>
        </section>
      )}
    </>
  );

  if (!view) {
    return <div className="settings-form">{banners}{!error && <p className="muted">Loading team…</p>}</div>;
  }

  if (!view.team) {
    return (
      <div className="settings-form">
        {banners}
        {!(pending && !pending.alreadyMember) && <section className="settings-section">
          <h4 className="settings-subhead">Start a team</h4>
          <p className="muted small">
            Invite the people you work with. You'll be the team's admin. Each member keeps their own machines and sessions;
            nobody in the team, admins included, can read yours.
          </p>
          <form className="field-row" onSubmit={(e) => { e.preventDefault(); void run("create", () => createTeam(local, name)); }}>
            <input className="field" value={name} maxLength={60} placeholder="Team name" aria-label="Team name" onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="btn primary" disabled={busy !== null || !name.trim()}>
              {busy === "create" ? "Creating…" : "Create team"}
            </button>
          </form>
        </section>}
        {dialog}
      </div>
    );
  }

  const { team, role, members, invites } = view;
  const admin = role === "admin";
  const admins = members.filter((m) => m.role === "admin").length;
  const me = members.find((m) => m.accountId === myId);
  const soleAdmin = admin && admins === 1 && members.length > 1;

  return (
    <div className="settings-form">
      {banners}
      {dialog}
      <section className="settings-section">
        <div className="settings-toggle-row">
          <span className="settings-toggle-text">
            <span className="settings-toggle-title">{team.name}</span>
            <span className="muted small">{members.length} {members.length === 1 ? "member" : "members"} · Since {formatDate(team.createdAt)}</span>
          </span>
          <Badge>{roleLabel(role)}</Badge>
        </div>
        {admin && (
          <form className="field-row" onSubmit={(e) => { e.preventDefault(); void run("rename", () => renameTeam(local, name), "Team renamed."); }}>
            <input className="field" value={name} maxLength={60} placeholder={team.name} aria-label="New team name" onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="btn" disabled={busy !== null || !name.trim() || name.trim() === team.name}>Rename</button>
          </form>
        )}
      </section>

      <section className="settings-section">
        <h4 className="settings-subhead">Members<span className="muted"> · {members.length}</span></h4>
        <div className="picker-list">
          {members.map((m) => {
            const self = m.accountId === myId;
            const lastAdmin = m.role === "admin" && admins === 1;
            return (
              <PickerItem
                key={m.accountId}
                layout="actions"
                title={`${m.email}${self ? " (you)" : ""}`}
                meta={`${roleLabel(m.role)} · Joined ${formatDate(m.joinedAt)}`}
                right={admin && !self ? (
                  <span className="row-actions">
                    <button type="button" className="btn sm" disabled={busy !== null || lastAdmin}
                      onClick={() => void run(`role:${m.accountId}`, () => setTeamMemberRole(local, m.accountId, m.role === "admin" ? "member" : "admin"))}>
                      {m.role === "admin" ? "Make member" : "Make admin"}
                    </button>
                    <button type="button" className="btn sm danger-ghost" disabled={busy !== null}
                      onClick={() => setConfirm({ title: "Remove member?", message: `Remove ${m.email} from ${team.name}?`, label: "Remove", action: () => removeTeamMember(local, m.accountId) })}>
                      Remove
                    </button>
                  </span>
                ) : undefined}
              />
            );
          })}
        </div>
      </section>

      <TeamInstructions state={state} />
      <TeamKeys state={state} />

      {admin && (
        <section className="settings-section">
          <h4 className="settings-subhead">Invite</h4>
          <form className="field-row" onSubmit={(e) => {
            e.preventDefault();
            void run("invite-email", async () => {
              const created = await createTeamInvite(local, { email: inviteEmail, role: inviteRole });
              setInviteEmail("");
              setLink(created.emailed ? null : created.url);
              setNotice(created.emailed ? `Invite sent to ${created.invite.email}.` : "Email isn't set up on this server. Send them this link instead.");
            });
          }}>
            <input className="field" type="email" value={inviteEmail} placeholder="name@example.com" aria-label="Email to invite" onChange={(e) => setInviteEmail(e.target.value)} />
            <select className="field" value={inviteRole} aria-label="Invite as" onChange={(e) => setInviteRole(e.target.value as TeamRole)}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button type="submit" className="btn primary" disabled={busy !== null || !inviteEmail.trim()}>
              {busy === "invite-email" ? "Sending…" : "Send invite"}
            </button>
          </form>
          <div className="row-actions">
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void run("invite-link", async () => {
              const created = await createTeamInvite(local, { role: inviteRole });
              setLink(created.url);
              copyLink(created.url);
            })}>
              {busy === "invite-link" ? "Creating…" : "Create invite link"}
            </button>
          </div>
          {link && (
            <div className="field-row">
              <input className="field" readOnly value={link} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn" onClick={() => copyLink(link)}>Copy</button>
            </div>
          )}
          <p className="muted small">Admins also manage members and invites. A link works for up to 25 people for 7 days; an email invite works once, for that address.</p>
          {invites.length > 0 && (
            <div className="picker-list">
              {invites.map((invite) => (
                <PickerItem
                  key={invite.id}
                  title={invite.email ?? "Invite link"}
                  meta={inviteMeta(invite)}
                  right={
                    <button type="button" className="btn sm danger-ghost" disabled={busy !== null}
                      onClick={() => void run(`revoke:${invite.id}`, () => revokeTeamInvite(local, invite.id), "Invite revoked.")}>
                      Revoke
                    </button>
                  }
                />
              ))}
            </div>
          )}
        </section>
      )}

      {view.policies && (
        <TeamAdmin policies={view.policies} admin={admin} onChanged={(policies) => setView({ ...view, policies })} />
      )}

      <section className="settings-section">
        <h4 className="settings-subhead">Leave</h4>
        {soleAdmin && <p className="muted small">You're the only admin. Make someone else an admin before you leave.</p>}
        <div className="row-actions">
          {me && (
            <button type="button" className="btn danger-ghost" disabled={busy !== null || soleAdmin}
              onClick={() => setConfirm({
                title: "Leave team?",
                message: members.length === 1 ? `You're the last member, so ${team.name} will be deleted.` : `You'll need a new invite to rejoin ${team.name}.`,
                label: "Leave",
                action: () => removeTeamMember(local, me.accountId),
              })}>
              Leave team
            </button>
          )}
          {admin && (
            <button type="button" className="btn danger-ghost" disabled={busy !== null}
              onClick={() => setConfirm({ title: "Delete team?", message: `Everyone leaves ${team.name} and its invites stop working.`, label: "Delete team", action: () => deleteTeam(local) })}>
              Delete team
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
