// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import type { Express, Request, RequestHandler, Response } from "express";

import type { DeploymentAccountEvent, DeploymentDecision, DeploymentOperation, DeploymentPolicyContext } from "./deployment-extension.js";
import type { Account, NodeRecord } from "./store.js";
import { TeamVaultError, type PostgresTeamVault } from "./team-vault.js";
import { normalizeTeamInvite, teamError, TeamError, type TeamInvite, type TeamMembership, type TeamRepository, isTeamRole } from "./teams.js";

export interface TeamRouteDeps {
  teams: TeamRepository;
  vault: PostgresTeamVault;
  requireUser: RequestHandler;
  requireNode: RequestHandler;
  /** Deployment admission. A deployment may decide who can start a team and
   * how many members one may have; with nothing configured both are open. */
  authorize(accountId: string, operation: DeploymentOperation, context: DeploymentPolicyContext): Promise<DeploymentDecision>;
  /** Best-effort: tell the deployment the roster changed (e.g. to count seats). */
  recordEvent(account: Account, event: DeploymentAccountEvent): void;
  /** Returns whether an email was actually sent (no sender in dev). */
  sendEmail(message: { to: string; subject: string; text: string; html: string }): Promise<boolean>;
  appUrl(req: Request): string;
}

const accountOf = (req: Request) => (req as Request & { account: Account }).account;
const nodeOf = (req: Request) => (req as Request & { node: NodeRecord }).node;

/** The token rides in the fragment, which browsers never send to a server, so
 * it can't end up in access logs or a proxy's history. */
export function teamInviteUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, "")}/team/join#${token}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]!);
}

export function teamInviteEmail(input: { teamName: string; inviter: string; url: string; expiresAt: string }) {
  const subject = `${input.inviter} invited you to ${input.teamName} on Bivy`;
  const expires = new Date(input.expiresAt).toUTCString();
  const text = `${input.inviter} invited you to join the team "${input.teamName}" on Bivy.\n\nJoin: ${input.url}\n\nThis invite expires ${expires}.`;
  const html = `<p>${escapeHtml(input.inviter)} invited you to join the team <strong>${escapeHtml(input.teamName)}</strong> on Bivy.</p>`
    + `<p><a href="${escapeHtml(input.url)}">Join ${escapeHtml(input.teamName)}</a></p><p>This invite expires ${escapeHtml(expires)}.</p>`;
  return { subject, text, html };
}

function inviteView(invite: TeamInvite) {
  const { id, email, role, createdAt, expiresAt, maxUses, uses } = invite;
  return { id, ...(email ? { email } : {}), role, createdAt, expiresAt, maxUses, uses };
}

export function registerTeamRoutes(app: Express, deps: TeamRouteDeps): void {
  const { teams, requireUser, requireNode } = deps;

  const handle = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => {
    fn(req, res).catch((error) => {
      if (error instanceof TeamError || error instanceof TeamVaultError) return res.status(error.status).json({ error: error.message, code: error.code });
      next(error);
    });
  };

  const membershipOf = async (req: Request): Promise<TeamMembership> => {
    const membership = await teams.teamOf(accountOf(req).id);
    if (!membership) throw teamError("not-in-team");
    return membership;
  };

  const adminOf = async (req: Request, res: Response): Promise<TeamMembership | undefined> => {
    const membership = await membershipOf(req);
    if (membership.role !== "admin") {
      res.status(403).json({ error: "Only a team admin can do that", code: "not-admin" });
      return undefined;
    }
    return membership;
  };

  /** A refusal carries the deployment's reason and any remediation actions. */
  const admitted = async (res: Response, accountId: string, operation: DeploymentOperation, context: DeploymentPolicyContext) => {
    const decision = await deps.authorize(accountId, operation, context);
    if (decision.allowed) return true;
    res.status(403).json({
      error: decision.reason || "Your deployment doesn't allow this",
      ...(decision.code ? { code: decision.code } : {}),
      ...(decision.actions?.length ? { actions: decision.actions } : {}),
    });
    return false;
  };

  const rosterChanged = async (account: Account, teamId: string) => {
    deps.recordEvent(account, { type: "team.members-changed", at: new Date().toISOString(), teamId, members: await teams.countMembers(teamId) });
  };

  const view = async (membership: TeamMembership | undefined) => {
    if (!membership) return { team: null };
    const members = await teams.listMembers(membership.team.id);
    const invites = membership.role === "admin" ? (await teams.listInvites(membership.team.id)).map(inviteView) : [];
    return { team: membership.team, role: membership.role, members, invites };
  };

  app.get("/account/team", requireUser, handle(async (req, res) => {
    res.json(await view(await teams.teamOf(accountOf(req).id)));
  }));

  app.post("/account/team", requireUser, handle(async (req, res) => {
    const account = accountOf(req);
    if (await teams.teamOf(account.id)) throw teamError("already-in-team");
    if (!(await admitted(res, account.id, "team.create", { teamMembers: 1 }))) return;
    const membership = await teams.createTeam(account.id, req.body?.name);
    await rosterChanged(account, membership.team.id);
    res.status(201).json(await view(membership));
  }));

  app.patch("/account/team", requireUser, handle(async (req, res) => {
    const membership = await adminOf(req, res);
    if (!membership) return;
    const team = await teams.renameTeam(membership.team.id, req.body?.name);
    res.json(await view({ ...membership, team }));
  }));

  app.delete("/account/team", requireUser, handle(async (req, res) => {
    const membership = await adminOf(req, res);
    if (!membership) return;
    await teams.deleteTeam(membership.team.id);
    deps.recordEvent(accountOf(req), { type: "team.members-changed", at: new Date().toISOString(), teamId: membership.team.id, members: 0 });
    res.json({ team: null });
  }));

  app.post("/account/team/invites", requireUser, handle(async (req, res) => {
    const membership = await adminOf(req, res);
    if (!membership) return;
    const account = accountOf(req);
    const input = normalizeTeamInvite(req.body ?? {});
    const { invite, token } = await teams.createInvite(membership.team.id, account.id, input);
    const url = teamInviteUrl(deps.appUrl(req), token);
    const emailed = invite.email
      ? await deps.sendEmail({ to: invite.email, ...teamInviteEmail({ teamName: membership.team.name, inviter: account.email, url, expiresAt: invite.expiresAt }) })
        .catch((error) => { console.warn(`[teams] invite email failed: ${error instanceof Error ? error.message : error}`); return false; })
      : false;
    res.status(201).json({ invite: inviteView(invite), url, emailed });
  }));

  app.delete("/account/team/invites/:id", requireUser, handle(async (req, res) => {
    const membership = await adminOf(req, res);
    if (!membership) return;
    const revoked = await teams.revokeInvite(membership.team.id, String(req.params.id));
    if (!revoked) return res.status(404).json({ error: "Invite not found" });
    res.json({ ok: true });
  }));

  app.patch("/account/team/members/:accountId", requireUser, handle(async (req, res) => {
    const membership = await adminOf(req, res);
    if (!membership) return;
    const role = req.body?.role;
    if (!isTeamRole(role)) return res.status(400).json({ error: "role must be admin or member" });
    await teams.setMemberRole(membership.team.id, String(req.params.accountId), role);
    res.json(await view(await teams.teamOf(accountOf(req).id)));
  }));

  // Admins remove anyone; anyone can remove themselves (leave).
  app.delete("/account/team/members/:accountId", requireUser, handle(async (req, res) => {
    const account = accountOf(req);
    const target = String(req.params.accountId);
    const membership = target === account.id ? await membershipOf(req) : await adminOf(req, res);
    if (!membership) return;
    const { teamDeleted } = await teams.removeMember(membership.team.id, target);
    if (!teamDeleted) await rosterChanged(account, membership.team.id);
    else deps.recordEvent(account, { type: "team.members-changed", at: new Date().toISOString(), teamId: membership.team.id, members: 0 });
    res.json(await view(await teams.teamOf(account.id)));
  }));

  // What the join page shows before the person commits. Needs a signed-in
  // account so an invite link can't be probed anonymously for team names.
  app.post("/account/team/invite-preview", requireUser, handle(async (req, res) => {
    const preview = await teams.previewInvite(String(req.body?.token ?? ""));
    if (!preview) throw teamError("invite-unavailable");
    const { teamId: _teamId, ...visible } = preview;
    const current = await teams.teamOf(accountOf(req).id);
    res.json({ ...visible, alreadyMember: current?.team.id === preview.teamId, inOtherTeam: Boolean(current && current.team.id !== preview.teamId) });
  }));

  app.post("/account/team/join", requireUser, handle(async (req, res) => {
    const account = accountOf(req);
    const token = String(req.body?.token ?? "");
    const preview = await teams.previewInvite(token);
    if (!preview) throw teamError("invite-unavailable");
    const current = await teams.teamOf(account.id);
    if (current?.team.id !== preview.teamId) {
      const members = await teams.countMembers(preview.teamId);
      if (!(await admitted(res, account.id, "team.member.add", { teamId: preview.teamId, teamMembers: members + 1 }))) return;
    }
    const membership = await teams.acceptInvite(token, account);
    if (current?.team.id !== membership.team.id) await rosterChanged(account, membership.team.id);
    res.json(await view(membership));
  }));

  // --- Team vault, for members' machines (team-vault.ts) --------------------
  // The machine's own account decides which team it serves; only ciphertext
  // and sealed keys pass through here.
  const teamOfNode = async (req: Request) => {
    const membership = await teams.teamOf(nodeOf(req).accountId);
    if (!membership) throw teamError("not-in-team");
    return membership;
  };

  app.get("/node/team-vault", requireNode, handle(async (req, res) => {
    const membership = await teams.teamOf(nodeOf(req).accountId);
    if (!membership) return res.json({ team: null });
    res.json({ team: { id: membership.team.id, name: membership.team.name }, role: membership.role, ...(await deps.vault.snapshot(membership.team.id, nodeOf(req).id)) });
  }));

  // Only admins' machines write, so only admins change what every member's agents read.
  app.put("/node/team-vault", requireNode, handle(async (req, res) => {
    const membership = await teamOfNode(req);
    if (membership.role !== "admin") return res.status(403).json({ error: "Only a team admin can change team instructions", code: "not-admin" });
    const vault = await deps.vault.write(membership.team.id, nodeOf(req).id, {
      ciphertext: String(req.body?.ciphertext ?? ""),
      expectedGeneration: Number(req.body?.expectedGeneration ?? 0),
      freshKey: req.body?.freshKey === true,
    });
    res.json({ vault });
  }));

  app.post("/node/team-vault/key-request", requireNode, handle(async (req, res) => {
    const membership = await teamOfNode(req);
    await deps.vault.requestKey(membership.team.id, nodeOf(req).id, String(req.body?.publicKey ?? ""));
    res.json({ ok: true });
  }));

  app.put("/node/team-vault/key", requireNode, handle(async (req, res) => {
    const membership = await teamOfNode(req);
    await deps.vault.putWrappedKey(membership.team.id, String(req.body?.targetNodeId ?? ""), {
      wrappedKey: String(req.body?.wrappedKey ?? ""),
      wrappedByPublicKey: String(req.body?.wrappedByPublicKey ?? ""),
      keyGeneration: Number(req.body?.keyGeneration ?? 0),
    });
    res.json({ ok: true });
  }));
}
