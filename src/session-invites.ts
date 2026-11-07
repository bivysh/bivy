// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * Inviting a teammate into one session on this machine, for a limited time.
 *
 * The machine's room key opens everything on it, so a guest never gets it.
 * Each invite has a key of its own, which the machine wraps for the guest's
 * devices when they pair (src/remote/relay-client.ts). A frame that opens
 * under an invite key is that guest's, and this module decides what it may
 * do: commands for its session only, from a fixed list per mode, and only
 * that session's events back. Revoking or expiring an invite deletes the key,
 * so the guest's devices can no longer read or send anything.
 *
 * The control plane learns only which account may reach which machine for
 * which session id until when (services/control-plane/src/team-machines.ts).
 */

export type InviteMode = "prompt" | "view";

export interface SessionInvite {
  id: string;
  sessionId: string;
  accountId: string;
  email: string;
  mode: InviteMode;
  createdAt: string;
  expiresAt: string;
  keyB64: string;
}

/** What a guest may send, by mode. Every command must name the invite's
 * session, except the few that only list what the guest may see. */
const VIEW_COMMANDS = ["session.open", "history", "session.checkpoints", "session.presence.get", "attachment.fetch"];
const PROMPT_COMMANDS = [
  ...VIEW_COMMANDS,
  "prompt", "abort", "approval", "session.question.answer", "session.turn_attention.resolve", "session.limit_retry",
  "session.presence.draft", "model.select", "thinking.set_level",
];
export const GUEST_COMMANDS: Record<InviteMode, ReadonlySet<string>> = {
  view: new Set(VIEW_COMMANDS),
  prompt: new Set(PROMPT_COMMANDS),
};
/** Allowed without a session id: they only list things, and the replies are filtered. */
export const GUEST_LISTING_COMMANDS: ReadonlySet<string> = new Set(["sessions.list", "runtimes.list", "models.list"]);

export const INVITE_DURATIONS_MS = { day: 24 * 60 * 60_000, week: 7 * 24 * 60 * 60_000 } as const;
export const MAX_INVITES = 100;

interface InviteFile { invites: SessionInvite[] }

export class SessionInvites {
  private readonly file: string;
  /** Read on every outgoing event, so kept in memory; the file is the record. */
  private cache: SessionInvite[] | undefined;

  constructor(appDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(appDir, "session-invites.json");
  }

  private read(): SessionInvite[] {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<InviteFile>;
      this.cache = Array.isArray(parsed.invites) ? parsed.invites.filter((i) => i && typeof i.keyB64 === "string") : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private write(invites: SessionInvite[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ invites }, null, 2)}\n`, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
    fs.renameSync(tmp, this.file);
    this.cache = invites;
  }

  get(id: string): SessionInvite | undefined {
    return this.list().find((i) => i.id === id);
  }

  /** Keep only invites the control plane accepted (current teammates). */
  keepRouted(kept: Array<{ accountId: string; sessionId: string }>): number {
    const allowed = new Set(kept.map((k) => `${k.accountId}\n${k.sessionId}`));
    const open = this.list();
    const rest = open.filter((i) => allowed.has(`${i.accountId}\n${i.sessionId}`));
    if (rest.length !== open.length) this.write(rest);
    return open.length - rest.length;
  }

  /** Open invites. Expired ones are dropped, with their keys, on every read. */
  list(): SessionInvite[] {
    const all = this.read();
    const open = all.filter((i) => Date.parse(i.expiresAt) > this.now());
    if (open.length !== all.length) this.write(open);
    return open;
  }

  create(input: { sessionId: string; accountId: string; email: string; mode: InviteMode; durationMs: number }): SessionInvite {
    if (!input.sessionId || !input.accountId) throw new Error("An invite needs a session and a teammate.");
    const open = this.list();
    // One invite per teammate per session: inviting again replaces it.
    const rest = open.filter((i) => !(i.sessionId === input.sessionId && i.accountId === input.accountId));
    if (rest.length >= MAX_INVITES) throw new Error(`This machine has the most open invites it allows (${MAX_INVITES}).`);
    const invite: SessionInvite = {
      id: `inv_${randomUUID()}`,
      sessionId: input.sessionId, accountId: input.accountId, email: input.email,
      mode: input.mode === "view" ? "view" : "prompt",
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + Math.min(Math.max(input.durationMs, 60_000), INVITE_DURATIONS_MS.week)).toISOString(),
      keyB64: randomBytes(32).toString("base64"),
    };
    this.write([...rest, invite]);
    return invite;
  }

  revoke(id: string): boolean {
    const open = this.list();
    const rest = open.filter((i) => i.id !== id);
    if (rest.length === open.length) return false;
    this.write(rest);
    return true;
  }

  /** Drop invites whose teammate is no longer in the team. Returns how many went. */
  keepMembers(memberAccountIds: string[]): number {
    const members = new Set(memberAccountIds);
    const open = this.list();
    const rest = open.filter((i) => members.has(i.accountId));
    if (rest.length !== open.length) this.write(rest);
    return open.length - rest.length;
  }

  /** The newest open invite for a teammate's account (what their device pairs into). */
  forAccount(accountId: string): SessionInvite | undefined {
    return this.list().filter((i) => i.accountId === accountId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  /** What the control plane is told: no keys, no emails. */
  routing(): Array<{ accountId: string; sessionId: string; mode: InviteMode; expiresAt: string }> {
    return this.list().map(({ accountId, sessionId, mode, expiresAt }) => ({ accountId, sessionId, mode, expiresAt }));
  }
}

/** Whether a guest may send this command. `sessionOf` finds the session a
 * command acts on (most carry `sessionId`; an approval is looked up by id). */
export function guestMayRun(invite: Pick<SessionInvite, "sessionId" | "mode">, command: { kind?: unknown }, sessionOf: (command: Record<string, unknown>) => string | undefined): { ok: true } | { ok: false; reason: string } {
  const kind = typeof command.kind === "string" ? command.kind : "";
  if (GUEST_LISTING_COMMANDS.has(kind)) return { ok: true };
  if (!GUEST_COMMANDS[invite.mode].has(kind)) {
    return { ok: false, reason: invite.mode === "view" ? "You can view this session, not change it." : "Guests can only work in the session they were invited to." };
  }
  if (sessionOf(command as Record<string, unknown>) !== invite.sessionId) return { ok: false, reason: "Guests can only work in the session they were invited to." };
  return { ok: true };
}

/** The session an event is about, if it names one. */
export function eventSessionId(event: unknown): string | undefined {
  const e = event as Record<string, any> | null;
  if (!e || typeof e !== "object") return undefined;
  const candidates = [e.sessionId, e.approval?.sessionId, e.question?.sessionId, e.session?.sessionId, e.session?.id, e.event?.sessionId];
  return candidates.find((value) => typeof value === "string" && value) as string | undefined;
}

/** A guest's request id as the machine runs it: in the guest's own namespace,
 *  so it can never match a request id another client is waiting on. */
export function guestRequestId(inviteId: string, requestId: string): string {
  return `guest.${inviteId}.${requestId}`;
}

/**
 * The copy of an outgoing event a guest may see, or null. Session lists are
 * cut to the guest's session (marked with the guest's mode, so the app can
 * stop a viewer from typing); replies to the guest's own requests pass, with
 * the id the guest sent; any other event passes only if it is about the
 * guest's session.
 */
export function guestEvent(invite: Pick<SessionInvite, "id" | "sessionId" | "mode">, event: unknown): unknown | null {
  const e = event as Record<string, any> | null;
  if (!e || typeof e !== "object") return null;
  if (e.type === "sessions.list" && Array.isArray(e.sessions)) {
    const sessions = e.sessions
      .filter((s: Record<string, unknown>) => s?.id === invite.sessionId || s?.sessionId === invite.sessionId)
      .map((s: Record<string, unknown>) => ({ ...s, guestMode: invite.mode }));
    return { ...e, sessions };
  }
  const own = guestRequestId(invite.id, "");
  if (typeof e.requestId === "string" && e.requestId.startsWith(own)) return { ...e, requestId: e.requestId.slice(own.length) };
  return eventSessionId(e) === invite.sessionId ? e : null;
}
