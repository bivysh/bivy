// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// A task the agent proposed with `bivy suggest`. It can run here, through this
// agent's sub-agents, or in a new session beside this one; the agent's `run`
// recommendation is the primary button and the rest stay one tap away. In a run
// of suggestions (consecutive cards) each card gets a checkbox and the last card
// holds one action bar for whatever is selected. What was started is remembered
// per device, so a reload doesn't offer it again.

import { useEffect, useId, useRef, useState } from "react";
import type { SuggestionRun, TaskSuggestion, TranscriptEntry } from "@bivy/core";
import { controller, useAppState } from "../store/useStore.js";

const startedKey = (id: string) => `bivy:suggestion:${id}`;
type Started = { where: "new"; sessionId: string } | { where: "here" | "subagents" };
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

const numbered = (items: TaskSuggestion[]) => items.map((s, i) => `${i + 1}. ${s.title ? `${s.title}: ` : ""}${s.text}`).join("\n\n");

/** Each way to start the selected tasks; `hint` explains the recommended one. Order is the order of the secondary buttons. */
const ACTIONS: Record<SuggestionRun, { label: (n: number) => string; hint: (n: number) => string; prompt?: (items: TaskSuggestion[]) => string; done: string }> = {
  here: {
    label: (n) => n > 1 ? `Do ${n} here` : "Do it here",
    hint: (n) => n > 1 ? "this session’s agent does them one after another." : "this session’s agent does it next.",
    prompt: (items) => items.length > 1 ? `Please do these ${items.length} tasks, one after another:\n\n${numbered(items)}` : items[0]!.text,
    done: "✓ Sent to this session",
  },
  subagents: {
    label: (n) => n > 1 ? `Run ${n} as sub-agents` : "Use a sub-agent",
    hint: () => "this session’s agent hands the work to its sub-agents and reports back.",
    prompt: (items) => items.length > 1
      ? `Please do these ${items.length} tasks in parallel, one sub-agent per task, then report back on each:\n\n${numbered(items)}`
      : `Please hand this task to a sub-agent, then report back:\n\n${items[0]!.text}`,
    done: "✓ Sent to this session’s sub-agents",
  },
  new: {
    label: (n) => n > 1 ? `Start ${n} new sessions` : "Start in new session",
    hint: (n) => n > 1 ? "each task gets its own agent, running side by side." : "it gets its own agent, running side by side with this one.",
    done: "✓ Started in a new session",
  },
};
const ORDER = Object.keys(ACTIONS) as SuggestionRun[];

/** What the agent recommends for `s`; without a choice, a lone card continues here and a set fans out. */
const recommended = (s: TaskSuggestion, inSet: boolean): SuggestionRun => s.run ?? (inSet ? "new" : "here");

function SuggestionDescription({ text }: { text: string }) {
  const id = useId();
  const body = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const element = body.current;
    if (!element || expanded) return;
    const measure = () => setTruncated(element.scrollHeight > element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <>
      <p ref={body} id={id} className="suggestion-text" data-expanded={expanded}>{text}</p>
      {truncated && (
        <div>
          <button type="button" className="btn sm ghost-link" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Show less" : "Show more"}
          </button>
        </div>
      )}
    </>
  );
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
  const inSet = run.length > 1;
  const open = run.filter((s) => !readStarted(s.id));
  const items = inSet ? open.filter((s) => !deselected.has(s.id)) : [suggestion];
  const label = suggestion.title || suggestion.text;
  const disabled = busy || !online || !sessionId || items.length === 0;

  // The selection's shared recommendation leads; mixed picks fall back to new sessions.
  const picks = new Set(items.map((s) => recommended(s, inSet)));
  const primary: SuggestionRun = picks.size === 1 ? [...picks][0]! : "new";
  // Sub-agents only show when the agent offered them: it knows whether it has any.
  const offered = ORDER.filter((key) => key !== "subagents" || run.some((s) => s.run === "subagents"));
  const actions = [primary, ...offered.filter((key) => key !== primary)];

  const start = async (how: SuggestionRun) => {
    const prompt = ACTIONS[how].prompt;
    if (prompt) {
      controller.sendPrompt(prompt(items));
      for (const item of items) remember(item.id, { where: how as "here" | "subagents" });
      return;
    }
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

  const bar = inSet ? last && open.length > 0 : !started;
  const n = items.length;
  return (
    <section className="card suggestion-card" aria-label={`Suggested task: ${label}`}>
      <p className="suggestion-eyebrow">Suggested task</p>
      {inSet && !started ? (
        <label className="suggestion-pick">
          <input type="checkbox" checked={!deselected.has(suggestion.id)} disabled={busy} onChange={(e) => setSelected(suggestion.id, e.target.checked)} />
          <span className="suggestion-title">{label}</span>
        </label>
      ) : <p className="suggestion-title">{label}</p>}
      {suggestion.title && <SuggestionDescription text={suggestion.text} />}
      {error && <div className="banner inline" data-tone="danger" role="alert">{error}</div>}
      {started && (
        <p className="suggestion-status" role="status">
          {ACTIONS[started.where].done}
          {started.where === "new" && <button type="button" className="btn sm ghost" onClick={() => controller.openSession(started.sessionId)}>Open</button>}
        </p>
      )}
      {bar && (
        <div className={inSet ? "suggestion-all" : "suggestion-bar"}>
          {inSet && <p className="suggestion-hint" role="status">{n === 0 ? "Select the tasks to start." : `${n} of ${open.length} selected`}</p>}
          <div className="suggestion-actions">
            {actions.map((key) => (
              <button key={key} type="button" className={`btn sm ${key === primary ? "primary" : "ghost"}`} disabled={disabled} onClick={() => void start(key)}>
                {busy && key === "new" ? "Starting…" : ACTIONS[key].label(Math.max(n, 1))}
              </button>
            ))}
          </div>
          <p className="suggestion-hint">Recommended: {ACTIONS[primary].hint(n)}</p>
        </div>
      )}
    </section>
  );
}
