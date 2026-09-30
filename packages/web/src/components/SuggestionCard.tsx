// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// A task the agent proposed with `bivy suggest`. A lone suggestion carries its
// own two actions: start it in a new session beside this one, or send it here.
// In a run of suggestions (consecutive cards) each card gets a checkbox and the
// last card holds one action bar for whatever is selected, so "here" versus
// "new sessions" is always a visible choice rather than implied by "parallel".
// What was started is remembered per device, so a reload doesn't offer it again.

import { useEffect, useState } from "react";
import type { TaskSuggestion, TranscriptEntry } from "@bivy/core";
import { controller, useAppState } from "../store/useStore.js";

const startedKey = (id: string) => `bivy:suggestion:${id}`;
type Started = { where: "new"; sessionId: string } | { where: "here" };
const changed = () => window.dispatchEvent(new Event("bivy:suggestions"));

function readStarted(id: string): Started | null {
  try { return JSON.parse(localStorage.getItem(startedKey(id)) ?? "null") as Started | null; } catch { return null; }
}
function remember(id: string, started: Started) {
  localStorage.setItem(startedKey(id), JSON.stringify(started));
  changed();
}

// Every card in a run starts selected; unticking one records it here.
const deselected = new Set<string>();
function setSelected(id: string, selected: boolean) {
  if (selected) deselected.delete(id); else deselected.add(id);
  changed();
}

/** The suggestions in the same run as `id` (consecutive suggestion entries). */
function runAround(transcript: TranscriptEntry[], id: string): { run: TaskSuggestion[]; last: boolean } {
  const at = transcript.findIndex((entry) => entry.suggestion?.id === id);
  if (at < 0) return { run: [], last: false };
  let start = at;
  let end = at;
  while (start > 0 && transcript[start - 1]?.suggestion) start--;
  while (transcript[end + 1]?.suggestion) end++;
  return { run: transcript.slice(start, end + 1).map((entry) => entry.suggestion!), last: at === end };
}

/** One message asking this session's agent to do several tasks. */
function combined(items: TaskSuggestion[]): string {
  if (items.length === 1) return items[0]!.text;
  return `Please do these ${items.length} tasks, one after another:\n\n${items.map((s, i) => `${i + 1}. ${s.title ? `${s.title}: ` : ""}${s.text}`).join("\n\n")}`;
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
  // Another card's action bar may start this one, or change the selection.
  useEffect(() => {
    const sync = () => { setStarted(readStarted(suggestion.id)); rerender((n) => n + 1); };
    window.addEventListener("bivy:suggestions", sync);
    return () => window.removeEventListener("bivy:suggestions", sync);
  }, [suggestion.id]);
  const { run, last } = runAround(state.activeSession.transcript, suggestion.id);
  const open = run.filter((s) => !readStarted(s.id));
  const inSet = run.length > 1;
  const selected = open.filter((s) => !deselected.has(s.id));
  const label = suggestion.title || suggestion.text;
  const disabled = busy || !online || !sessionId;

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
  const doHere = (items: TaskSuggestion[]) => {
    controller.sendPrompt(combined(items));
    for (const item of items) remember(item.id, { where: "here" });
  };

  const checkbox = inSet && !started;
  return (
    <section className="card suggestion-card" aria-label={`Suggested task: ${label}`}>
      <p className="suggestion-eyebrow">Suggested task</p>
      {checkbox ? (
        <label className="suggestion-pick">
          <input type="checkbox" checked={!deselected.has(suggestion.id)} disabled={busy} onChange={(e) => setSelected(suggestion.id, e.target.checked)} />
          <span className="suggestion-title">{label}</span>
        </label>
      ) : <p className="suggestion-title">{label}</p>}
      {suggestion.title && <p className="suggestion-text">{suggestion.text}</p>}
      {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
      {started && (
        <p className="suggestion-status" role="status">
          {started.where === "here" ? "✓ Sent to this session" : <>✓ Started in a new session <button type="button" className="btn sm ghost" onClick={() => controller.openSession(started.sessionId)}>Open</button></>}
        </p>
      )}
      {!started && !inSet && (
        <div className="suggestion-actions">
          <button type="button" className="btn sm primary" disabled={disabled} onClick={() => void startNew([suggestion])}>
            {busy ? "Starting…" : "Start in new session"}
          </button>
          <button type="button" className="btn sm ghost" disabled={disabled} onClick={() => doHere([suggestion])}>Do it here</button>
        </div>
      )}
      {inSet && last && open.length > 0 && (
        <div className="suggestion-all">
          <p className="suggestion-hint" role="status">
            {selected.length === 0 ? "Select the tasks to start." : `${selected.length} of ${open.length} selected`}
          </p>
          <div className="suggestion-actions">
            <button type="button" className="btn sm primary" disabled={disabled || selected.length === 0} onClick={() => void startNew(selected)}>
              {busy ? "Starting…" : selected.length > 1 ? `Start ${selected.length} new sessions` : "Start in new session"}
            </button>
            <button type="button" className="btn sm ghost" disabled={disabled || selected.length === 0} onClick={() => doHere(selected)}>
              {selected.length > 1 ? `Do ${selected.length} here` : "Do it here"}
            </button>
          </div>
          <p className="suggestion-hint">
            New sessions: each task gets its own agent, running side by side. Here: this session&rsquo;s agent does them one after another.
          </p>
        </div>
      )}
    </section>
  );
}
