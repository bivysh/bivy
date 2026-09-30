// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useState } from "react";

/** When the owner last looked at a session's reviewer notes (epoch ms), kept
 *  per session on this device. A note newer than this is "new". */
const key = (sessionId: string) => `bivy:notes-seen:${sessionId}`;
const EVENT = "bivy:notes-seen";

export function notesSeenAt(sessionId: string): number {
  return Number(localStorage.getItem(key(sessionId))) || 0;
}

export function markNotesSeen(sessionId: string, at: number): void {
  if (at <= notesSeenAt(sessionId)) return;
  localStorage.setItem(key(sessionId), String(at));
  window.dispatchEvent(new CustomEvent(EVENT, { detail: sessionId }));
}

/** Count of notes newer than the last look, re-read when it's marked seen. */
export function useNewNotes(sessionId: string | undefined, noteTimes: readonly number[]): number {
  const [seen, setSeen] = useState(() => (sessionId ? notesSeenAt(sessionId) : 0));
  useEffect(() => {
    if (!sessionId) return;
    setSeen(notesSeenAt(sessionId));
    const onSeen = (event: Event) => { if ((event as CustomEvent).detail === sessionId) setSeen(notesSeenAt(sessionId)); };
    window.addEventListener(EVENT, onSeen);
    return () => window.removeEventListener(EVENT, onSeen);
  }, [sessionId]);
  return noteTimes.filter((at) => at > seen).length;
}
