// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// A task this session handed to another agent, maybe on another machine
// (`bivy delegate`, docs/agent-delegation.md). The card updates in place while
// the child works and opens the child session. Children fanned out together
// (`bivy delegate --to a,b,c`) render as one comparison, the first card of the
// group drawing the whole set, with "Use this" to go on from one result.

import type { DelegationCard as Card } from "@bivy/core";
import { controller, useAppState } from "../store/useStore.js";

const STATUS: Record<string, { label: string; tone?: string }> = {
  pending: { label: "Queued", tone: "accent" },
  claimed: { label: "Starting", tone: "accent" },
  running: { label: "Working", tone: "accent" },
  waiting: { label: "Waiting", tone: "accent" },
  needs_attention: { label: "Needs attention", tone: "warn" },
  succeeded: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled" },
};

function useTarget(card: Card): { agent: string; label: string } {
  const state = useAppState();
  const agent = card.agent ? state.catalogs.runtimes.find((rt) => rt.id === card.agent)?.displayName || card.agent : "Default agent";
  return { agent, label: card.machine ? `${agent} @ ${card.machine}` : agent };
}

function Status({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status };
  return <span className="badge" data-tone={s.tone}>{s.label}</span>;
}

function Body({ card, target, compact }: { card: Card; target: { agent: string }; compact?: boolean }) {
  const open = () => card.childSessionId && controller.openSessionOnNode(card.childSessionId, undefined, card.nodeId);
  return (
    <>
      <div className="delegation-head">
        <span className="delegation-target">
          {target.agent}
          {card.machine && <span className="delegation-machine">on {card.machine}</span>}
        </span>
        <Status status={card.status} />
      </div>
      {!compact && <p className="delegation-task">{card.task}</p>}
      {card.failure && <p className="delegation-failure">{card.failure}</p>}
      {card.answer && (
        <details className="delegation-answer" open={compact}>
          <summary>Answer</summary>
          <p>{card.answer}</p>
        </details>
      )}
      {(card.branch || card.prUrl) && (
        <p className="delegation-refs">
          {card.branch && <code>{card.branch}</code>}
          {card.prUrl && <a href={card.prUrl} target="_blank" rel="noreferrer">Pull request</a>}
        </p>
      )}
      {card.childSessionId && (
        <div className="delegation-actions">
          <button type="button" className="btn sm ghost" onClick={open}>Open session</button>
        </div>
      )}
    </>
  );
}

function Member({ card }: { card: Card }) {
  const target = useTarget(card);
  const done = card.status === "succeeded";
  const adopt = () => controller.sendPrompt(
    `Go with ${target.label}'s result (delegated run ${card.id})${card.branch ? `. Its work is on branch \`${card.branch}\`: fetch it and merge it into the current branch` : ""}.`,
  );
  return (
    <section className="card delegation-member" aria-label={`${target.label}: ${STATUS[card.status]?.label ?? card.status}`}>
      <Body card={card} target={target} compact />
      {done && <button type="button" className="btn sm primary" onClick={adopt}>Use this</button>}
    </section>
  );
}

export function DelegationCard({ delegation }: { delegation: Card }) {
  const state = useAppState();
  const target = useTarget(delegation);
  if (delegation.group) {
    const members = state.activeSession.transcript.flatMap((entry) => entry.delegation && entry.delegation.group === delegation.group ? [entry.delegation] : []);
    if (members[0]?.id !== delegation.id) return null;
    const settled = members.filter((m) => ["succeeded", "failed", "cancelled"].includes(m.status)).length;
    return (
      <section className="delegation-group" aria-label={`Compared across ${members.length} agents`}>
        <p className="delegation-eyebrow">Compared across {members.length} agents · {settled}/{members.length} finished</p>
        <p className="delegation-task">{delegation.task}</p>
        <div className="delegation-grid">
          {members.map((member) => <Member key={member.id} card={member} />)}
        </div>
      </section>
    );
  }
  return (
    <section className="card delegation-card" aria-label={`Delegated to ${target.label}`}>
      <p className="delegation-eyebrow">Delegated</p>
      <Body card={delegation} target={target} />
    </section>
  );
}
