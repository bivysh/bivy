// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
import { writeClipboard } from "../clipboard.js";
import type { UserQuestionRequest } from "@bivy/core";

// A blocking, multiple-choice clarifying question the agent raised mid-turn
// (e.g. Claude's AskUserQuestion tool) — distinct from ApprovalCard, which is
// scoped to yes/no tool-permission decisions. Mirrors ApprovalCard's own
// pending-state handling: the card stays up until the node's
// session.question.resolved confirms the answer was actually delivered.

// See ApprovalCard's STALL_MS — same rationale: no protocol-level ack/timeout
// for an answer/cancel send, so a dropped resolution otherwise leaves the
// card pending forever with no way out.
const STALL_MS = 8000;

/** "github.com" for the Open button; the whole URL if it doesn't parse. */
function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; }
}

/** A copy button that says "Copied" for a moment. */
function CopyText({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => void writeClipboard(text).then((ok) => {
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  });
  return <button type="button" className="btn ghost sm" onClick={copy}>{copied ? "Copied" : label}</button>;
}

/** The page a step happens on (`bivy ask --url`) and the one-time code to
 *  enter there (`--code`), or a command the user runs themselves in a terminal
 *  on the machine (`--run`): the terminal opens with it typed, not run. */
function QuestionStep({ url, code, command, onRunInTerminal }: { url?: string; code?: string; command?: string; onRunInTerminal?: (command: string) => void }) {
  return (
    <div className="question-step">
      {code && (
        <div className="question-code">
          <code aria-label="Code">{code}</code>
          <CopyText text={code} label="Copy" />
        </div>
      )}
      {url && <a className="btn sm" href={url} target="_blank" rel="noopener noreferrer">Open {hostOf(url)} ↗</a>}
      {command && (
        <>
          <div className="question-command">
            <code aria-label="Command">{command}</code>
            <CopyText text={command} label="Copy" />
          </div>
          {onRunInTerminal && <button type="button" className="btn sm" onClick={() => onRunInTerminal(command)}>Open terminal</button>}
          <p className="question-note">{onRunInTerminal ? "The terminal opens with this typed; you press Enter. The agent doesn't see what you type there." : "Run it in a terminal on this machine, then answer here."}</p>
        </>
      )}
    </div>
  );
}

function QuestionCard({
  request,
  onAnswer,
  onCancel,
  onRunInTerminal,
}: {
  request: UserQuestionRequest;
  onAnswer: (id: string, sessionId: string | undefined, answers: Record<string, string>) => void;
  onCancel: (id: string, sessionId: string | undefined) => void;
  onRunInTerminal?: (command: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [stalled, setStalled] = useState(false);
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Remembered so Retry can resend the same action (answer vs. skip) without
  // re-deriving it from current selection state, which the user may have kept
  // interacting with... though the buttons are disabled while pending, this
  // keeps retry exact regardless.
  const lastAction = useRef<"answer" | "skip" | null>(null);

  useEffect(() => () => { if (stallTimer.current) clearTimeout(stallTimer.current); }, []);

  const armStallTimer = () => {
    if (stallTimer.current) clearTimeout(stallTimer.current);
    stallTimer.current = setTimeout(() => setStalled(true), STALL_MS);
  };
  // Keyed by index, not question text: AskUserQuestion's schema has no
  // uniqueness constraint on `question`, so two identically-worded questions
  // in the same request (e.g. two generic "Which approach?" items with
  // different headers) would collide on a text key — selecting one would
  // silently overwrite the other's selection. Only converted to the
  // text-keyed shape the SDK actually wants (UserQuestionAnswer.answers) at
  // submit time, joined with ", " for multiSelect per AskUserQuestionOutput.
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  // "Other" free-text answers, keyed by question index — mirrors
  // AskUserQuestion, which always lets the user supply their own answer
  // instead of picking a provided option. Tracked separately from `selected`
  // (which holds provided-option labels) so custom text never collides with
  // an option label, and so an empty "Other" box can't count as answered.
  // A question with no options (`bivy ask` without --option) is free text: its
  // answer box is open from the start.
  const [otherActive, setOtherActive] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(request.questions.map((q, qi) => [qi, q.options.length === 0])));
  const [otherText, setOtherText] = useState<Record<number, string>>({});

  const toggle = (qi: number, label: string, multiSelect: boolean | undefined) => {
    setSelected((prev) => {
      const current = prev[qi] || [];
      if (!multiSelect) return { ...prev, [qi]: current[0] === label ? [] : [label] };
      const has = current.includes(label);
      return { ...prev, [qi]: has ? current.filter((l) => l !== label) : [...current, label] };
    });
    // Single-select: picking a provided option clears any pending "Other".
    if (!multiSelect) setOtherActive((prev) => ({ ...prev, [qi]: false }));
  };

  const toggleOther = (qi: number, multiSelect: boolean | undefined) => {
    setOtherActive((prev) => {
      const next = !prev[qi];
      // Single-select: activating "Other" clears provided-option selections.
      if (next && !multiSelect) setSelected((s) => ({ ...s, [qi]: [] }));
      return { ...prev, [qi]: next };
    });
  };

  const isAnswered = (qi: number) => {
    if ((selected[qi] || []).length > 0) return true;
    return !!otherActive[qi] && (otherText[qi] || "").trim().length > 0;
  };
  const answered = request.questions.every((_, qi) => isAnswered(qi));

  // Build the { question → answer } payload from the current selection, including
  // any "Other" free-text. Shared by submit and retry so a resend never silently
  // drops the custom answer (retry used to rebuild from `selected` alone).
  const buildAnswers = (): Record<string, string> => {
    const answers: Record<string, string> = {};
    request.questions.forEach((q, qi) => {
      const parts = [...(selected[qi] || [])];
      if (otherActive[qi]) {
        const custom = (otherText[qi] || "").trim();
        if (custom) parts.push(custom);
      }
      answers[q.question] = parts.join(", ");
    });
    return answers;
  };

  const send = (answers: Record<string, string>) => {
    lastAction.current = "answer";
    setPending(true);
    setStalled(false);
    onAnswer(request.id, request.sessionId, answers);
    armStallTimer();
  };
  const submit = () => send(buildAnswers());
  // One question, one pick from plain options: tapping an option is the answer,
  // so there is no separate Send. "Other" still opens a box and a Send button.
  const only = request.questions.length === 1 ? request.questions[0] : undefined;
  const oneTap = !!only && !only.secret && !only.multiSelect && only.options.length > 0;
  const pick = (qi: number, label: string, multiSelect: boolean | undefined) => {
    if (!oneTap || !only) return toggle(qi, label, multiSelect);
    setSelected({ [qi]: [label] });
    setOtherActive({ [qi]: false });
    send({ [only.question]: label });
  };
  const skip = () => {
    lastAction.current = "skip";
    setPending(true);
    setStalled(false);
    onCancel(request.id, request.sessionId);
    armStallTimer();
  };
  const retry = () => {
    setStalled(false);
    if (lastAction.current === "skip") {
      onCancel(request.id, request.sessionId);
    } else {
      onAnswer(request.id, request.sessionId, buildAnswers());
    }
    armStallTimer();
  };

  return (
    <div id={`attention-${encodeURIComponent(request.id)}`} className="card question-card" data-attention-card tabIndex={-1}>
      {request.questions.map((q, qi) => {
        const picked = selected[qi] || [];
        return (
          <div className="question-item" key={qi}>
            {q.header && <div className="card-eyebrow">{q.header}</div>}
            <div className="question-text" id={`${request.id}-q${qi}`}>{q.question}</div>
            {!q.secret && (q.url || q.code || q.command) && <QuestionStep url={q.url} code={q.code} command={q.command} onRunInTerminal={onRunInTerminal} />}
            {q.secret ? (
              <div className="question-field">
                <input
                  className="field"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={otherText[qi] || ""}
                  onChange={(e) => setOtherText((prev) => ({ ...prev, [qi]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter" && answered && !pending) submit(); }}
                  placeholder="Paste it here"
                  aria-label={q.question}
                  disabled={pending}
                />
                <p className="question-note">
                  Saved on this machine as <code>{q.secret.name}</code>. The agent gets a reference to it, never the value.
                  {q.url && <> <a href={q.url} target="_blank" rel="noopener noreferrer">Where to find it</a></>}
                </p>
              </div>
            ) : q.options.length > 0 && (
              <div className="question-options" role={q.multiSelect ? "group" : "radiogroup"} aria-labelledby={`${request.id}-q${qi}`}>
                {q.options.map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    role={q.multiSelect ? "checkbox" : "radio"}
                    aria-checked={picked.includes(opt.label)}
                    className="question-option"
                    data-multi={q.multiSelect || undefined}
                    onClick={() => pick(qi, opt.label, q.multiSelect)}
                    disabled={pending}
                  >
                    <span className="question-option-label">{opt.label}</span>
                    {opt.description && <span className="question-option-desc">{opt.description}</span>}
                  </button>
                ))}
                <button
                  type="button"
                  role={q.multiSelect ? "checkbox" : "radio"}
                  aria-checked={!!otherActive[qi]}
                  className="question-option"
                  data-multi={q.multiSelect || undefined}
                  onClick={() => toggleOther(qi, q.multiSelect)}
                  disabled={pending}
                >
                  <span className="question-option-label">Other…</span>
                </button>
              </div>
            )}
            {!q.secret && otherActive[qi] && (
              <textarea
                className="field question-other-input"
                value={otherText[qi] || ""}
                onChange={(e) => setOtherText((prev) => ({ ...prev, [qi]: e.target.value }))}
                placeholder="Type your answer…"
                aria-label={q.question}
                rows={2}
                autoFocus={q.options.length > 0}
                disabled={pending}
              />
            )}
          </div>
        );
      })}
      {pending ? (
        <div className="approval-waiting">
          Sending your answer…
          {stalled && (
            <div className="approval-stalled">
              <span>This is taking longer than expected.</span>
              <button type="button" className="btn ghost" onClick={retry}>
                Retry
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="approval-actions">
          <button className="btn ghost" onClick={skip}>
            Skip
          </button>
          {(!oneTap || otherActive[0]) && <button className="btn primary" onClick={submit} disabled={!answered}>
            {request.questions.every((q) => q.secret) ? "Save secret" : `Send answer${request.questions.length > 1 ? "s" : ""}`}
          </button>}
        </div>
      )}
    </div>
  );
}

export function QuestionStack({
  questions,
  onAnswer,
  onCancel,
  onRunInTerminal,
}: {
  questions: UserQuestionRequest[];
  onAnswer: (id: string, sessionId: string | undefined, answers: Record<string, string>) => void;
  onCancel: (id: string, sessionId: string | undefined) => void;
  /** Opens a terminal with a `--run` command typed; without it the card offers Copy only. */
  onRunInTerminal?: (command: string) => void;
}) {
  if (questions.length === 0) return null;
  return (
    <div className="approval-stack">
      {questions.map((q) => (
        <QuestionCard key={q.id} request={q} onAnswer={onAnswer} onCancel={onCancel} onRunInTerminal={onRunInTerminal} />
      ))}
    </div>
  );
}
