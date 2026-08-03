// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState } from "react";
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

function QuestionCard({
  request,
  onAnswer,
  onCancel,
}: {
  request: UserQuestionRequest;
  onAnswer: (id: string, sessionId: string | undefined, answers: Record<string, string>) => void;
  onCancel: (id: string, sessionId: string | undefined) => void;
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
  const [otherActive, setOtherActive] = useState<Record<number, boolean>>({});
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

  const submit = () => {
    lastAction.current = "answer";
    setPending(true);
    setStalled(false);
    onAnswer(request.id, request.sessionId, buildAnswers());
    armStallTimer();
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
    <div id={`attention-${encodeURIComponent(request.id)}`} className="question-card">
      {request.questions.map((q, qi) => {
        const picked = selected[qi] || [];
        return (
          <div className="question-item" key={qi}>
            <div className="question-head">
              <span className="question-chip">{q.header}</span>
            </div>
            <div className="question-text">{q.question}</div>
            <div className="question-options">
              {q.options.map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  className={`question-option${picked.includes(opt.label) ? " selected" : ""}`}
                  onClick={() => toggle(qi, opt.label, q.multiSelect)}
                  disabled={pending}
                  title={opt.description}
                >
                  <span className="question-option-label">{opt.label}</span>
                  {opt.description && <span className="question-option-desc">{opt.description}</span>}
                </button>
              ))}
              <button
                type="button"
                className={`question-option${otherActive[qi] ? " selected" : ""}`}
                onClick={() => toggleOther(qi, q.multiSelect)}
                disabled={pending}
              >
                <span className="question-option-label">Other</span>
                <span className="question-option-desc">Write your own answer</span>
              </button>
              {otherActive[qi] && (
                <textarea
                  className="question-other-input"
                  value={otherText[qi] || ""}
                  onChange={(e) => setOtherText((prev) => ({ ...prev, [qi]: e.target.value }))}
                  placeholder="Type your answer…"
                  rows={2}
                  autoFocus
                  disabled={pending}
                />
              )}
            </div>
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
          <button className="btn danger-ghost" onClick={skip}>
            Skip
          </button>
          <button className="btn primary" onClick={submit} disabled={!answered}>
            Send answer{request.questions.length > 1 ? "s" : ""}
          </button>
        </div>
      )}
    </div>
  );
}

export function QuestionStack({
  questions,
  onAnswer,
  onCancel,
}: {
  questions: UserQuestionRequest[];
  onAnswer: (id: string, sessionId: string | undefined, answers: Record<string, string>) => void;
  onCancel: (id: string, sessionId: string | undefined) => void;
}) {
  if (questions.length === 0) return null;
  return (
    <div className="approval-stack">
      {questions.map((q) => (
        <QuestionCard key={q.id} request={q} onAnswer={onAnswer} onCancel={onCancel} />
      ))}
    </div>
  );
}
