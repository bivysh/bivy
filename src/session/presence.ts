// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Which device is driving a session, and the draft it left behind. This is a
// soft lease, not a lock. Nothing is ever refused because another device drove
// last; it only lets the next device say "you were on your Mac a minute ago" and
// carry the unsent draft over. Devices name themselves (the room key already
// trusts every linked device, so this is presentation, not authentication).
// In-memory: a handoff is minutes-scale, and a node restart is a fine reset.

export interface DeviceRef {
  id: string;
  label: string;
}

export type DriveVia = "chat" | "terminal";

export interface SessionPresence {
  sessionId: string;
  driver?: DeviceRef & { via: DriveVia; at: number };
  draft?: { device: DeviceRef; text: string; at: number };
}

/** Longest device label kept; they're shown in a one-line strip. */
const LABEL_MAX = 60;
/** Longest draft carried between devices. */
const DRAFT_MAX = 20_000;
/** A driver that keeps typing re-announces at most this often. */
const REANNOUNCE_MS = 30_000;
/** Presence older than this is forgotten. */
const TTL_MS = 6 * 60 * 60 * 1000;

/** A device reference from untrusted client input, or undefined. */
export function deviceFrom(value: unknown): DeviceRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { id, label } = value as { id?: unknown; label?: unknown };
  if (typeof id !== "string" || !id.trim() || id.length > 100) return undefined;
  const name = typeof label === "string" && label.trim() ? label.trim().slice(0, LABEL_MAX) : "Another device";
  return { id: id.trim(), label: name };
}

export class PresenceBook {
  private readonly sessions = new Map<string, SessionPresence>();

  constructor(private readonly now: () => number = Date.now) {}

  get(sessionId: string): SessionPresence {
    this.expire();
    return this.sessions.get(sessionId) ?? { sessionId };
  }

  /** A device sent input to the session. Returns the presence to broadcast when
   *  the driver changed (or is due a re-announce), else undefined. A chat send
   *  also consumes that device's draft, since the draft has now been sent. */
  drove(sessionId: string, device: DeviceRef, via: DriveVia): SessionPresence | undefined {
    const at = this.now();
    const entry = this.entry(sessionId);
    const previous = entry.driver;
    entry.driver = { ...device, via, at };
    const sentDraft = via === "chat" && entry.draft?.device.id === device.id;
    if (sentDraft) entry.draft = undefined;
    const changed = !previous || previous.id !== device.id || previous.via !== via || at - previous.at >= REANNOUNCE_MS;
    return changed || sentDraft ? { ...entry } : undefined;
  }

  /** A device's unsent draft for the session (empty text clears it). */
  draft(sessionId: string, device: DeviceRef, text: string): SessionPresence {
    const entry = this.entry(sessionId);
    const trimmed = text.slice(0, DRAFT_MAX);
    if (trimmed.trim()) entry.draft = { device, text: trimmed, at: this.now() };
    else if (entry.draft?.device.id === device.id) entry.draft = undefined;
    return { ...entry };
  }

  private entry(sessionId: string): SessionPresence {
    this.expire();
    let entry = this.sessions.get(sessionId);
    if (!entry) { entry = { sessionId }; this.sessions.set(sessionId, entry); }
    return entry;
  }

  private expire(): void {
    const cutoff = this.now() - TTL_MS;
    for (const [id, entry] of this.sessions) {
      if (entry.driver && entry.driver.at < cutoff) entry.driver = undefined;
      if (entry.draft && entry.draft.at < cutoff) entry.draft = undefined;
      if (!entry.driver && !entry.draft) this.sessions.delete(id);
    }
  }
}
