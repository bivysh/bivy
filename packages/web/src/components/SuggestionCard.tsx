// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// A task the agent proposed with `bivy suggest`. One tap starts it in its own
// session beside this one (the primary action), or
// sends it here. The last card of a run of suggestions can start them all.
// What was started is remembered per device, so a reload doesn't offer it again.

import { useEffect, useState } from "react";
import type { TaskSuggestion, TranscriptEntry } from "@bivy/core";
import { controller, useAppState } from "../store/useStore.js";

const startedKey = (id: string) => `bivy:suggestion:${id}`;
type Started = { where: "new"; sessionId: string } | { where: "here" };

function readStarted(id: string): Started | null {
  try { return JSON.parse(localStorage.getItem(startedKey(id)) ?? "null") as Started | null; } catch { return null; }
}
function remember(id: string, started: Started) {
  localStorage.setItem(startedKey(id), JSON.stringify(started));
  window.dispatchEvent(new Event("bivy:suggestions"));
}

/** The unstarted suggestions in the same run as `id` (consecutive suggestion entries), if `id` ends the run. */
function runEndingAt(transcript: TranscriptEntry[], id: string): TaskSuggestion[] {
  const end = transcript.findIndex((entry) => entry.suggestion?.id === id);
  if (end < 0 || transcript[end + 1]?.suggestion) return [];
  let start = end;
  while (start > 0 && transcript[start - 1]?.suggestion) start--;
  return transcript.slice(start, end + 1).map((entry) => entry.suggestion!).filter((s) => !readStarted(s.id));
}

/** Rendered inside the active session's transcript; that session is the one it runs beside. */
export function SuggestionCard({ suggestion }: { suggestion: TaskSuggestion }) {
  const state = useAppState();
  const sessionId = state.activeSession.activeSessionId ?? "";
  const online = state.connection.status === "online";
  const [started, setStarted] = useState<Started | null>(() => readStarted(suggestion.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, rerender] = useState(0);
  // "Run all" on another card may start this one.
  useEffect(() => {
    const sync = () => { setStarted(readStarted(suggestion.id)); rerender((n) => n + 1); };
    window.addEventListener("bivy:suggestions", sync);
    return () => window.removeEventListener("bivy:suggestions", sync);
  }, [suggestion.id]);
  const run = runEndingAt(state.activeSession.transcript, suggestion.id);
  // One primary action on screen: a lone suggestion's start, or "Run all" for a set.
  const inSet = Boolean(state.activeSession.transcript.find((entry, i, all) => entry.suggestion?.id === suggestion.id && (all[i - 1]?.suggestion || all[i + 1]?.suggestion)));
  const label = suggestion.title || suggestion.text;

  const startNew = async (items: TaskSuggestion[]) => {
    setBusy(true);
    setError(null);
    try {
      // One at a time: each is its own session on the same machine.
      for (const item of items) {
        const id = await controller.startSessionLike(sessionId, item.text);
        remember(item.id, { where: "new", sessionId: id });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const doHere = () => {
    controller.sendPrompt(suggestion.text);
    remember(suggestion.id, { where: "here" });
    setStarted({ where: "here" });
  };

  return (
    <section className="card suggestion-card" aria-label={`Suggested task: ${label}`}>
      <p className="suggestion-eyebrow">Suggested task</p>
      <p className="suggestion-title">{label}</p>
      {suggestion.title && <p className="suggestion-text">{suggestion.text}</p>}
      {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
      {started ? (
        <p className="suggestion-status" role="status">
          {started.where === "here" ? "✓ Sent here" : <>✓ Started in a new session <button type="button" className="btn sm ghost" onClick={() => controller.openSession(started.sessionId)}>Open</button></>}
        </p>
      ) : (
        <div className="suggestion-actions">
          <button type="button" className={`btn sm${inSet ? "" : " primary"}`} disabled={busy || !online || !sessionId} onClick={() => void startNew([suggestion])}>
            {busy ? "Starting…" : "Start in new session"}
          </button>
          <button type="button" className="btn sm ghost" disabled={busy || !online || !sessionId} onClick={doHere}>Do it here</button>
        </div>
      )}
      {run.length > 1 && (
        <div className="suggestion-all">
          <button type="button" className="btn sm primary" disabled={busy || !online || !sessionId} onClick={() => void startNew(run)}>
            Run all {run.length} in parallel
          </button>
        </div>
      )}
    </section>
  );
}
