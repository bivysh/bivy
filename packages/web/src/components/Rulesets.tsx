// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Settings → Rulesets. Create, view, and edit run-orchestration rulesets
// (docs/rulesets.md): user-authored policy that decides what happens when a run
// fails — retry, reroute through a fallback chain, or park for a human.
//
// The node owns the registry and validates authoritatively on save (typebox,
// src/policy/ruleset.ts). This is a structured editor over that schema: it can
// only express valid shapes, and surfaces the node's validation error if one
// slips through. One ruleset may be marked ACTIVE — the one the work queue runs
// under (otherwise the built-in default applies).

import { useEffect, useState, type ReactNode } from "react";
import type {
  AppState,
  RuleCondition,
  RuleContext,
  Ruleset,
  RulesetBackoff,
  RulesetInfo,
  RulesetRoutingCandidate,
  RulesetRule,
} from "@bivy/core";
import { controller } from "../store/useStore.js";
import { PickerItem } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { Badge } from "./Badge.js";

// The stable failure conditions a rule can match, with a short human label so
// the editor never asks the user to know the raw code taxonomy by heart.
const CONDITIONS: Array<{ id: RuleCondition; label: string; hint: string }> = [
  { id: "rate_limited", label: "Rate limited", hint: "429 / overloaded / retry-after" },
  { id: "credits_exhausted", label: "Session / credits", hint: "quota, credit balance, or session usage limit; Retry waits for a supplied reset time" },
  { id: "context_overflow", label: "Context overflow", hint: "prompt exceeds the context window" },
  { id: "auth_failed", label: "Auth failed", hint: "401 / invalid key" },
  { id: "node_offline", label: "Machine offline", hint: "connection refused / unreachable" },
  { id: "transport_error", label: "Transport error", hint: "socket hang up / timeout / 502" },
  { id: "task_failed", label: "Task failed", hint: "tests failed / made no changes" },
  { id: "unknown", label: "Unknown", hint: "anything unclassified" },
];

const ACTIONS: Array<{ id: RulesetRule["action"]; label: string; hint: string }> = [
  { id: "retry", label: "Retry", hint: "Resume at the provider's reset/retry time when supplied; otherwise use backoff, up to the attempt limit." },
  { id: "reroute", label: "Reroute", hint: "Fall back down a chain of routes, then park/give up." },
  { id: "park", label: "Park", hint: "Stop and flag for a human — no automatic recovery." },
];

const CONTEXTS: Array<{ id: RuleContext; label: string; hint: string }> = [
  { id: "queue", label: "Work queue", hint: "Unattended runs (GitHub / webhooks)." },
  { id: "session", label: "Session", hint: "Interactive chats — resume when a usage/rate limit resets, or reroute to a fallback model." },
];

const DEFAULT_BACKOFF: RulesetBackoff = { baseMs: 2000, factor: 2, capMs: 60_000, jitter: 0.3 };

/** A fresh ruleset to seed the "New ruleset" editor with a safe starting rule. */
function blankRuleset(): Ruleset {
  return {
    version: 1,
    name: "",
    appliesTo: ["queue"],
    rules: [{ when: ["transport_error", "node_offline"], action: "retry", maxAttempts: 3, backoff: { ...DEFAULT_BACKOFF } }],
  };
}

/** One-line summary of a ruleset for the list row. */
function summarize(rs: RulesetInfo): string {
  const where = rs.appliesTo.map((c) => CONTEXTS.find((x) => x.id === c)?.label ?? c).join(" + ");
  return `${rs.rules.length} rule${rs.rules.length === 1 ? "" : "s"} · ${where || "no contexts"}`;
}

/** Strip a draft rule down to only the fields its action uses, so the payload
 *  the node validates never carries e.g. a chain on a `park` rule. */
function cleanRule(rule: RulesetRule): RulesetRule {
  const out: RulesetRule = {
    when: rule.when,
    action: rule.action,
    maxAttempts: rule.maxAttempts,
  };
  if (rule.action === "retry" || rule.action === "reroute") {
    if (rule.backoff) out.backoff = rule.backoff;
    if (rule.onExhausted) out.onExhausted = rule.onExhausted;
  }
  if (rule.action === "reroute") {
    out.chain = (rule.chain ?? []).map((c) => {
      const cand: RulesetRoutingCandidate = {};
      if (c.runtimeId?.trim()) cand.runtimeId = c.runtimeId.trim();
      if (c.model?.trim()) cand.model = c.model.trim();
      if (c.account?.trim()) cand.account = c.account.trim();
      if (c.label?.trim()) cand.label = c.label.trim();
      return cand;
    });
  }
  return out;
}

export function RulesetsPanel({ state }: { state: AppState }) {
  // A draft under edit. `isNew` gates whether the name is editable (the name is
  // the registry key — renaming an existing one would fork it, so we lock it).
  const [draft, setDraft] = useState<Ruleset | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; action: () => void }>(null);

  useEffect(() => {
    controller.listRulesets();
  }, []);

  const openNew = () => {
    setError(null);
    setActive(false);
    setIsNew(true);
    setDraft(blankRuleset());
  };
  const openExisting = (rs: RulesetInfo) => {
    setError(null);
    setActive(rs.active);
    setIsNew(false);
    // Clone so edits don't mutate the stored object held in state.
    const { active: _active, ...ruleset } = rs;
    setDraft(JSON.parse(JSON.stringify(ruleset)) as Ruleset);
  };
  const close = () => {
    setDraft(null);
    setError(null);
  };

  if (draft) {
    return (
      <RulesetEditor
        draft={draft}
        setDraft={setDraft}
        isNew={isNew}
        active={active}
        setActive={setActive}
        busy={busy}
        error={error}
        onCancel={close}
        onSave={async () => {
          setBusy(true);
          setError(null);
          try {
            const ruleset: Ruleset = { ...draft, name: draft.name.trim(), rules: draft.rules.map(cleanRule) };
            await controller.saveRuleset(ruleset, active);
            controller.listRulesets();
            close();
          } catch (e) {
            setError(String((e as Error)?.message || e));
          } finally {
            setBusy(false);
          }
        }}
      />
    );
  }

  return (
    <div className="settings-form">
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => { confirm.action(); setConfirm(null); }}
        />
      )}

      <p className="muted settings-intro">
        A ruleset is policy for what happens when a run fails — a rate limit, an exhausted quota, an offline machine.
        Each rule matches one or more failure conditions and decides whether to retry, reroute through a fallback
        chain, or park the run for a human. The <strong>active</strong> ruleset steers this machine's work queue and
        interactive sessions (per the contexts it applies to); with none active, a safe built-in default applies.
        Rulesets are stored on this machine.
      </p>

      <div className="picker-list">
        {state.settings.rulesets.length === 0 && <div className="picker-empty">No rulesets yet.</div>}
        {state.settings.rulesets.map((rs) => (
          <PickerItem
            key={rs.name}
            title={rs.name}
            meta={summarize(rs)}
            right={
              <span className="row-actions">
                {rs.active && <Badge tone="ok">Active</Badge>}
                <button
                  className="btn danger-ghost sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirm({
                      title: "Remove ruleset?",
                      message: `Remove "${rs.name}"?${rs.active ? " It's currently active — the work queue will fall back to the built-in default." : ""}`,
                      action: () => {
                        controller.removeRuleset(rs.name);
                        setTimeout(() => controller.listRulesets(), 400);
                      },
                    });
                  }}
                >
                  Remove
                </button>
              </span>
            }
            onClick={() => openExisting(rs)}
          />
        ))}
      </div>

      <button className="btn primary block" onClick={openNew}>+ New ruleset</button>
    </div>
  );
}

// --- Editor -----------------------------------------------------------------

function RulesetEditor({
  draft,
  setDraft,
  isNew,
  active,
  setActive,
  busy,
  error,
  onCancel,
  onSave,
}: {
  draft: Ruleset;
  setDraft: (next: Ruleset) => void;
  isNew: boolean;
  active: boolean;
  setActive: (v: boolean) => void;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = (patch: Partial<Ruleset>) => setDraft({ ...draft, ...patch });
  const setRule = (i: number, next: RulesetRule) => set({ rules: draft.rules.map((r, j) => (j === i ? next : r)) });

  const toggleContext = (ctx: RuleContext) => {
    const has = draft.appliesTo.includes(ctx);
    const next = has ? draft.appliesTo.filter((c) => c !== ctx) : [...draft.appliesTo, ctx];
    set({ appliesTo: next });
  };

  const appliesToQueue = draft.appliesTo.includes("queue");
  const appliesToSession = draft.appliesTo.includes("session");
  // The active ruleset drives whichever contexts it applies to (the node reads it
  // per-context), so it's activatable as soon as it covers queue and/or session.
  const activatable = appliesToQueue || appliesToSession;
  // Client-side gate mirroring the schema's hard requirements, so Save is only
  // enabled when the node will actually accept it (name, ≥1 context, ≥1 rule,
  // and every rule matching ≥1 condition).
  const nameOk = draft.name.trim().length > 0;
  const rulesOk = draft.rules.length > 0 && draft.rules.every((r) => r.when.length > 0);
  const canSave = nameOk && draft.appliesTo.length > 0 && rulesOk && !busy;

  return (
    <div className="settings-form">
      <button className="btn link" onClick={onCancel}>‹ All rulesets</button>
      <h3>{isNew ? "New ruleset" : draft.name}</h3>

      <label className="field-label">Name</label>
      <input
        className="picker-search"
        value={draft.name}
        placeholder="my-fallback-policy"
        disabled={!isNew}
        onChange={(e) => set({ name: e.target.value })}
      />
      {!isNew && <p className="muted small">The name is the identifier and can't be changed — create a new ruleset to rename.</p>}

      <label className="field-label" style={{ marginTop: 8 }}>Applies to</label>
      <div className="seg-row">
        {CONTEXTS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`seg-btn${draft.appliesTo.includes(c.id) ? " active" : ""}`}
            title={c.hint}
            onClick={() => toggleContext(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="settings-toggle-row" style={{ marginTop: 8 }}>
        <div className="settings-toggle-text">
          <span className="settings-toggle-title">Active on this machine</span>
          <span className="muted small">
            {activatable
              ? `Use this ruleset for ${appliesToQueue && appliesToSession ? "queue runs and interactive sessions" : appliesToQueue ? "unattended queue runs" : "interactive sessions"} on this machine. Only one ruleset is active at a time.`
              : "Add a context above (Work queue or Session) to make this ruleset selectable as active."}
          </span>
        </div>
        <SmallToggle checked={active && activatable} disabled={!activatable} onChange={setActive} label="Active on this machine" />
      </div>

      <label className="field-label" style={{ marginTop: 8 }}>Rules</label>
      <p className="muted small">Rules are matched top to bottom; the first rule whose conditions include the failure wins.</p>
      {draft.rules.map((rule, i) => (
        <RuleCard
          key={i}
          index={i}
          rule={rule}
          onChange={(next) => setRule(i, next)}
          onRemove={() => set({ rules: draft.rules.filter((_, j) => j !== i) })}
        />
      ))}
      <button
        className="btn block"
        onClick={() => set({ rules: [...draft.rules, { when: [], action: "retry", maxAttempts: 3, backoff: { ...DEFAULT_BACKOFF } }] })}
      >
        + Add rule
      </button>

      <div className="row-actions" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={!canSave} onClick={onSave}>
          {busy ? "Saving…" : isNew ? "Create ruleset" : "Save changes"}
        </button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
      {error && <div className="banner error inline">{error}</div>}
    </div>
  );
}

function RuleCard({
  index,
  rule,
  onChange,
  onRemove,
}: {
  index: number;
  rule: RulesetRule;
  onChange: (next: RulesetRule) => void;
  onRemove: () => void;
}) {
  const set = (patch: Partial<RulesetRule>) => onChange({ ...rule, ...patch });
  const toggleCondition = (id: RuleCondition) => {
    const has = rule.when.includes(id);
    set({ when: has ? rule.when.filter((c) => c !== id) : [...rule.when, id] });
  };
  const setBackoff = (patch: Partial<RulesetBackoff>) => set({ backoff: { ...(rule.backoff ?? DEFAULT_BACKOFF), ...patch } });
  const showRecovery = rule.action === "retry" || rule.action === "reroute";

  return (
    <div className="ruleset-rule-card">
      <div className="ruleset-rule-head">
        <span className="settings-toggle-title">Rule {index + 1}</span>
        <button className="btn danger-ghost sm" onClick={onRemove}>Remove</button>
      </div>

      <label className="field-label">When any of</label>
      <div className="ruleset-chip-row">
        {CONDITIONS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`ruleset-chip${rule.when.includes(c.id) ? " active" : ""}`}
            title={c.hint}
            aria-pressed={rule.when.includes(c.id)}
            onClick={() => toggleCondition(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      {rule.when.length === 0 && <p className="muted small">Pick at least one condition.</p>}

      <label className="field-label">Then</label>
      <div className="seg-row">
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`seg-btn${rule.action === a.id ? " active" : ""}`}
            title={a.hint}
            onClick={() => set({ action: a.id })}
          >
            {a.label}
          </button>
        ))}
      </div>
      <p className="muted small">{ACTIONS.find((a) => a.id === rule.action)?.hint}</p>

      <div className="ruleset-field-grid">
        <div>
          <label className="field-label">Max attempts</label>
          <input
            className="picker-search"
            type="number"
            min={1}
            max={100}
            value={rule.maxAttempts}
            onChange={(e) => set({ maxAttempts: clampInt(e.target.value, 1, 100, rule.maxAttempts) })}
          />
        </div>
        {showRecovery && (
          <div>
            <label className="field-label">When exhausted</label>
            <select
              className="picker-search"
              value={rule.onExhausted ?? "park"}
              onChange={(e) => set({ onExhausted: e.target.value as RulesetRule["onExhausted"] })}
            >
              <option value="park">Park for a human</option>
              <option value="give_up">Give up (fail the run)</option>
            </select>
          </div>
        )}
      </div>

      {rule.action === "reroute" && <ChainEditor chain={rule.chain ?? []} onChange={(chain) => set({ chain })} />}

      {showRecovery && (
        <Collapsible label="Backoff (advanced)">
          <div className="ruleset-field-grid">
            <NumField label="Base (ms)" value={rule.backoff?.baseMs ?? DEFAULT_BACKOFF.baseMs} min={0} onChange={(v) => setBackoff({ baseMs: v })} />
            <NumField label="Factor" value={rule.backoff?.factor ?? DEFAULT_BACKOFF.factor} min={1} step={0.1} onChange={(v) => setBackoff({ factor: v })} />
            <NumField label="Cap (ms)" value={rule.backoff?.capMs ?? DEFAULT_BACKOFF.capMs} min={0} onChange={(v) => setBackoff({ capMs: v })} />
            <NumField label="Jitter (0–1)" value={rule.backoff?.jitter ?? DEFAULT_BACKOFF.jitter} min={0} max={1} step={0.05} onChange={(v) => setBackoff({ jitter: v })} />
          </div>
        </Collapsible>
      )}
    </div>
  );
}

function ChainEditor({ chain, onChange }: { chain: RulesetRoutingCandidate[]; onChange: (next: RulesetRoutingCandidate[]) => void }) {
  const setAt = (i: number, patch: Partial<RulesetRoutingCandidate>) =>
    onChange(chain.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="ruleset-chain">
      <label className="field-label">Fallback chain</label>
      <p className="muted small">
        Tried in order; the first candidate with valid credentials on the machine wins. Leave a field blank to keep the
        failed run's current value.
      </p>
      {chain.map((cand, i) => (
        <div className="ruleset-chain-row" key={i}>
          <div className="ruleset-chain-fields">
            <label className="ruleset-chain-field">
              <span>Model</span>
              <input className="picker-search" placeholder="e.g. claude-sonnet" value={cand.model ?? ""} onChange={(e) => setAt(i, { model: e.target.value })} />
            </label>
            <label className="ruleset-chain-field">
              <span>Agent</span>
              <input className="picker-search" placeholder="e.g. codex" value={cand.runtimeId ?? ""} onChange={(e) => setAt(i, { runtimeId: e.target.value })} />
            </label>
            <label className="ruleset-chain-field">
              <span>Account</span>
              <input className="picker-search" placeholder="Keep current" value={cand.account ?? ""} onChange={(e) => setAt(i, { account: e.target.value })} />
            </label>
          </div>
          <button className="btn danger-ghost sm ruleset-chain-remove" onClick={() => onChange(chain.filter((_, j) => j !== i))} aria-label={`Remove candidate ${i + 1}`}>Remove</button>
        </div>
      ))}
      <button className="btn sm" onClick={() => onChange([...chain, {}])}>+ Add candidate</button>
    </div>
  );
}

// --- Small shared bits ------------------------------------------------------

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function NumField({ label, value, min, max, step, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="field-label">{label}</label>
      <input
        className="picker-search"
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </div>
  );
}

function SmallToggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`settings-toggle${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-toggle-knob" aria-hidden />
    </button>
  );
}

function Collapsible({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ruleset-collapsible">
      <button type="button" className="btn link" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "▾" : "▸"} {label}
      </button>
      {open && <div className="ruleset-collapsible-body">{children}</div>}
    </div>
  );
}
