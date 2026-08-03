// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useMemo, useRef, useState } from "react";
import type { AppState, ModelInfo, RuntimeInfo } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { Sheet, PickerItem } from "./Sheet.js";
import { useModalEscape } from "../modalStack.js";
import { ProviderConnectForm } from "./ProviderConnect.js";
import { SANDBOX_TIERS } from "./Settings.js";

function agentLabel(a: RuntimeInfo): string {
  return String(a.displayName || a.name || a.id || "Agent");
}

const THINKING_LABELS: Record<string, string> = {
  off: "Fastest",
  minimal: "Minimal",
  low: "Light",
  medium: "Default",
  high: "Deep",
};

function runtimeCapabilityChips(a: RuntimeInfo): Array<{ label: string; ok: boolean }> {
  const caps = (a.capabilities || {}) as Record<string, unknown>;
  const mode = String((a as { executionMode?: unknown }).executionMode || "");
  const modeLabel = mode === "protocol" ? "Protocol" : mode === "structured-pipe" ? "Structured" : mode === "pipe" ? "Chat pipe" : mode === "pty" ? "Terminal" : "";
  // "Approvals" is on for native per-tool interception OR the MCP-proxy gate
  // (which governs the agent's MCP tool calls through the same Approve/Deny flow).
  return [
    ...(modeLabel ? [{ label: modeLabel, ok: true }] : []),
    { label: "Approvals", ok: Boolean(caps.toolInterception) || Boolean(caps.mcpToolApprovals) },
    { label: "Resume", ok: Boolean(caps.resume) },
    { label: "Models", ok: Boolean(caps.modelSelection) },
    { label: "Fork", ok: Boolean(caps.fork) },
  ];
}

function runtimeTier(runtime: RuntimeInfo): string {
  return String((runtime as { supportTier?: unknown }).supportTier || "experimental");
}

function tierLabel(tier: string): string {
  if (tier === "supported") return "Supported";
  if (tier === "beta") return "Beta";
  if (tier === "planned") return "Planned";
  return "Experimental";
}

function RuntimeMeta({ runtime, text }: { runtime: RuntimeInfo; text?: string }) {
  const tier = runtimeTier(runtime);
  return (
    <span className="runtime-meta">
      {text && <span className="runtime-meta-text">{text}</span>}
      <span className="runtime-capabilities" aria-label="Runtime support tier and capabilities">
        <span className={`runtime-tier ${tier}`}>{tierLabel(tier)}</span>
        {runtimeCapabilityChips(runtime).map((chip) => (
          <span key={chip.label} className={`runtime-cap ${chip.ok ? "ok" : "limited"}`} title={chip.ok ? `${chip.label} supported` : `${chip.label} not supported by this runtime`}>
            {chip.ok ? "✓" : "–"} {chip.label}
          </span>
        ))}
      </span>
    </span>
  );
}

// ---- Repo picker (new session) ----
export function RepoPicker({ state, onClose }: { state: AppState; onClose: () => void }) {
  const [q, setQ] = useState("");
  // When set, we've drilled into the branch list for this repo slug — opened
  // by the ›-arrow on a repo row (#466). Tapping a repo row itself picks it on
  // its default branch; the arrow is the "…but from a specific branch" path.
  const [branchFor, setBranchFor] = useState<string | null>(null);
  useEffect(() => {
    controller.listRepos();
    // Warm the branch list for the already-picked repo so drilling into it via
    // the arrow is instant (stale-while-revalidate — no spinner if cached).
    const repo = state.draftRepo;
    if (repo) controller.listBranches(repo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { repos, repoTotal } = useMemo(() => {
    const query = q.trim().toLowerCase();
    const list = query
      ? state.repos.filter((r) => `${r.slug} ${r.description || ""}`.toLowerCase().includes(query))
      : state.repos;
    return { repos: list.slice(0, 60), repoTotal: list.length };
  }, [state.repos, q]);

  if (branchFor) {
    return <RepoBranchPicker state={state} repo={branchFor} onBack={() => setBranchFor(null)} onClose={onClose} />;
  }

  return (
    <Sheet title="Repository" onClose={onClose}>
      <input className="picker-search" placeholder="Search repos…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="picker-list">
        <PickerItem
          active={!state.draftRepo}
          title="No repo"
          meta="Work in the node's default workspace"
          onClick={() => {
            controller.chooseRepo(null);
            onClose();
          }}
        />
        {state.reposLoading && <div className="picker-empty">Loading repos…</div>}
        {!state.reposLoading && !state.reposAuthed && (
          <div className="picker-empty">Connect GitHub on this node to list repos.</div>
        )}
        {!state.reposLoading && state.reposError && <div className="picker-empty">{state.reposError}</div>}
        {repos.map((r) => {
          const picked = r.slug === state.draftRepo;
          return (
            <PickerItem
              key={r.slug}
              active={picked}
              title={r.slug}
              // Once picked, echo which branch this repo will start from (a
              // specific pick, else its default) so the choice is visible
              // without reopening the branch list.
              meta={[
                r.private ? "private" : null,
                picked ? (state.draftBranch ? `branch: ${state.draftBranch}` : "default branch") : null,
                r.description,
              ]
                .filter(Boolean)
                .join(" · ")}
              right={
                <button
                  type="button"
                  className="picker-action repo-branch-arrow"
                  title={`Choose a branch of ${r.slug}`}
                  aria-label={`Choose a branch of ${r.slug}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    controller.listBranches(r.slug);
                    setBranchFor(r.slug);
                  }}
                >
                  ›
                </button>
              }
              onClick={() => {
                controller.chooseRepo(r.slug);
                onClose();
              }}
            />
          );
        })}
        {repoTotal > repos.length && (
          <div className="picker-empty">Showing first {repos.length} of {repoTotal} — search to narrow.</div>
        )}
      </div>
    </Sheet>
  );
}

// ---- Branch sub-picker (drilled in from a repo row, #466) ----
// Reached via the ›-arrow on a repo row. Lets the draft clone from a specific
// remote branch of `repo` instead of its default; a back arrow returns to the
// repo list. Picking here sets BOTH the repo and the branch, so it's a
// complete choice on its own (you never have to also tap the repo row).
function RepoBranchPicker({
  state,
  repo,
  onBack,
  onClose,
}: {
  state: AppState;
  repo: string;
  onBack: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  // The store's branch fields describe whichever repo branches.list last
  // resolved for (branchesRepo); until that catches up to the repo we drilled
  // into, show the loading state rather than another repo's branches.
  const loading = state.branchesLoading || state.branchesRepo !== repo;
  const { branches, branchTotal } = useMemo(() => {
    const query = q.trim().toLowerCase();
    const list = query ? state.branches.filter((b) => b.name.toLowerCase().includes(query)) : state.branches;
    return { branches: list.slice(0, 200), branchTotal: list.length };
  }, [state.branches, q]);
  // Prefer the default branch from the repo listing (already loaded) so the
  // "Default branch (main)" row is labelled and pickable INSTANTLY — before the
  // branch list itself finishes loading. Falls back to whatever branches.list
  // reported for older nodes that don't carry it on RepoInfo.
  const defaultBranch =
    state.repos.find((r) => r.slug === repo)?.defaultBranch ?? (state.branchesRepo === repo ? state.branchesDefault : null) ?? null;
  // The active tick reflects the current draft only when it's this same repo;
  // drilling into a different repo starts from "default branch".
  const activeBranch = state.draftRepo === repo ? state.draftBranch : null;

  // Commit a repo+branch pick in one shot. Picking the default branch
  // normalizes to null, so the repo pill never shows a redundant "@ main".
  const pick = (name: string | null) => {
    controller.chooseRepoBranch(repo, name && name !== defaultBranch ? name : null);
    onClose();
  };

  return (
    <Sheet
      title={repo}
      onClose={onClose}
      headExtra={
        <button className="sheet-back" onClick={onBack} aria-label="Back to repositories">
          ‹
        </button>
      }
    >
      <input className="picker-search" placeholder="Search branches…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="picker-list">
        <PickerItem
          active={!activeBranch}
          title={`Default branch${defaultBranch ? ` (${defaultBranch})` : ""}`}
          meta="Clone and start from the repo's default branch"
          onClick={() => pick(null)}
        />
        {loading && <div className="picker-empty">Loading branches…</div>}
        {!loading && state.branchesError && <div className="picker-empty">{state.branchesError}</div>}
        {!loading && !state.branchesError && branches.length === 0 && q && (
          <div className="picker-empty">No branches match “{q}”.</div>
        )}
        {!loading &&
          branches.map((b) => (
            <PickerItem
              key={b.name}
              active={b.name === activeBranch}
              title={b.name}
              meta={b.name === defaultBranch ? "Default" : undefined}
              onClick={() => pick(b.name)}
            />
          ))}
        {!loading && branchTotal > branches.length && (
          <div className="picker-empty">Showing first {branches.length} of {branchTotal} — search to narrow.</div>
        )}
      </div>
    </Sheet>
  );
}

// ---- Sandbox picker (new session) ----
// The sandbox tier bakes into the agent's native launch flags when the session
// is created, so it's chosen up front on the draft — never mid-run (a running
// session shows it read-only in Session settings). A blank pick defers to the
// node default (Settings → Nodes).
export function SandboxPicker({ state, onClose }: { state: AppState; onClose: () => void }) {
  const nodeDefault = state.nodeSettings?.defaultSandbox;
  return (
    <Sheet title="Sandbox mode" onClose={onClose} autoFocusSearch={false}>
      <div className="picker-list">
        <PickerItem
          active={!state.draftSandbox}
          title={`Node default${nodeDefault ? ` (${nodeDefault})` : ""}`}
          meta="Use this node's configured sandbox mode"
          onClick={() => {
            controller.setSessionSandbox(null);
            onClose();
          }}
        />
        {SANDBOX_TIERS.map((t) => (
          <PickerItem
            key={t.id}
            active={state.draftSandbox === t.id}
            title={t.label}
            meta={t.hint}
            onClick={() => {
              controller.setSessionSandbox(t.id);
              onClose();
            }}
          />
        ))}
      </div>
    </Sheet>
  );
}

// ---- Node picker (standalone terminal) ----
// Only shown when there's more than one node to choose from — see
// App.tsx's openStandaloneTerminal, which skips straight to the sole node
// otherwise. Defaults the checkmark to the currently connected node.
export function NodePicker({
  state,
  currentNodeId,
  onPick,
  onClose,
}: {
  state: AppState;
  currentNodeId: string | null;
  onPick: (nodeId: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title="Open terminal on" onClose={onClose} autoFocusSearch={false}>
      <div className="picker-list">
        {state.nodes.length === 0 && <div className="picker-empty">No nodes available.</div>}
        {state.nodes.map((n) => (
          <PickerItem
            key={n.id}
            active={n.id === currentNodeId}
            title={n.name || n.id}
            meta={n.online ? "Online" : "Offline"}
            onClick={() => onPick(n.id)}
          />
        ))}
      </div>
    </Sheet>
  );
}

// ---- Agent picker ----
export function AgentPicker({ state, onClose }: { state: AppState; onClose: () => void }) {
  const [q, setQ] = useState("");
  useEffect(() => {
    controller.listRuntimes();
  }, []);
  const runtimes = useMemo(() => {
    const query = q.trim().toLowerCase();
    const matched = !query
      ? state.runtimes
      : state.runtimes.filter((a) =>
          `${a.id} ${a.name || ""} ${a.displayName || ""} ${(a as any).description || ""} ${(a as any).language || ""}`.toLowerCase().includes(query),
        );
    // Sort the selector by display name, ascending (A→Z, case-insensitive), so the
    // agent list is predictable regardless of catalog insertion order.
    return [...matched].sort((a, b) => agentLabel(a).localeCompare(agentLabel(b), undefined, { sensitivity: "base" }));
  }, [state.runtimes, q]);

  const cloningActiveSession = Boolean(state.activeSessionId);
  // For an active session, "current" means the runtime that owns that session,
  // never the globally last-used/default runtime for new drafts.
  const selectedAgentId = cloningActiveSession
    ? state.activeRuntimeId ?? state.sessions.find((s) => s.sessionId === state.activeSessionId)?.runtimeId ?? null
    : state.selectedAgentId ?? (state.runtimes.find((r) => (r as any).current)?.id || null);

  return (
    <Sheet title={cloningActiveSession ? "Hand off to agent" : "Agent"} onClose={onClose} autoFocusSearch={false}>
      {cloningActiveSession && (
        <div className="picker-empty">
          Choosing an agent forks this session with its transcript and working files, then opens the fork in that agent.
        </div>
      )}
      <input className="picker-search" placeholder="Search agents…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="picker-list">
        {runtimes.length === 0 && <div className="picker-empty">No agents available.</div>}
        {runtimes.map((a) => {
          const status = String((a as any).status || "available");
          const available = status === "available";
          const installable = !available && Boolean((a as any).install);
          const installing = state.installingRuntimeId === a.id;
          const active = a.id === selectedAgentId;
          const chips = [
            installing ? "setting up…" : null,
            !available ? status : null,
            (a as any).language,
            (a as { authOwner?: string }).authOwner ? `auth: ${(a as { authOwner?: string }).authOwner}` : null,
          ].filter(Boolean).join(" · ");
          return (
            <PickerItem
              key={a.id}
              active={active}
              title={agentLabel(a)}
              meta={
                <RuntimeMeta
                  runtime={a}
                  text={cloningActiveSession
                    ? ["Fork + handoff", chips || (a as any).description].filter(Boolean).join(" · ")
                    : chips || (a as any).description}
                />
              }
              disabled={installing || (!available && !installable)}
              right={
                installable && !installing ? (
                  <button
                    type="button"
                    className="picker-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      controller.installAgent(a.id);
                    }}
                  >
                    Install
                  </button>
                ) : undefined
              }
              onClick={() => {
                if (installable) {
                  controller.installAgent(a.id);
                  return;
                }
                if (available) {
                  controller.chooseAgent(a);
                  onClose();
                }
              }}
            />
          );
        })}
      </div>
    </Sheet>
  );
}

// ---- Model picker (+ reasoning pill) ----
function ReasoningPill({ state }: { state: AppState }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Dismiss the dropdown on an outside tap or Escape — it's inside the model
  // picker sheet, so Escape here closes just this menu (topmost layer), not the
  // sheet. Without this it only closed by re-tapping the pill or choosing a
  // level, and tapping elsewhere left it floating, which read as stuck.
  useModalEscape(() => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  const t = state.thinking;
  if (!t.supportsThinking || !t.availableThinkingLevels || t.availableThinkingLevels.length <= 1) return null;
  const label = THINKING_LABELS[t.thinkingLevel] || t.thinkingLevel;
  return (
    <div className="reasoning-wrap" ref={wrapRef}>
      <button className="reasoning-pill" onClick={() => setOpen((v) => !v)}>
        ✦ {label} {open ? "▾" : "▸"}
      </button>
      {open && (
        <div className="reasoning-menu">
          {t.availableThinkingLevels.map((lvl) => (
            <button
              key={lvl}
              className={`reasoning-opt${lvl === t.thinkingLevel ? " active" : ""}`}
              onClick={() => {
                controller.setThinkingLevel(lvl);
                setOpen(false);
              }}
            >
              {THINKING_LABELS[lvl] || lvl}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function modelMeta(m: ModelInfo): string {
  const ctx = (m as any).contextWindow;
  return [(m as any).provider, ctx ? `${Math.round(ctx / 1000)}k ctx` : null].filter(Boolean).join(" · ");
}

export function ModelPicker({ state, onClose }: { state: AppState; onClose: () => void }) {
  const [q, setQ] = useState("");
  // Id of the unconnected provider the user tapped "Connect" on, if any —
  // swaps the list view for an inline add-credentials form (#390) instead of
  // sending the user to Settings. Just the id (not a name snapshot) so the
  // header stays live if providers.list resolves the display name later.
  const [connecting, setConnecting] = useState<string | null>(null);
  useEffect(() => {
    controller.listModels();
    controller.listProviders();
  }, []);

  // The connect form has no direct ack of its own; once the node's next
  // providers.list reports this provider configured, its models already moved
  // into the connected section server-side (getModels() vs getAllModels()) —
  // just pull a fresh models.list and pop back to the plain picker so the user
  // sees the model they just unlocked, connected.
  useEffect(() => {
    if (!connecting) return;
    const provider = state.providers.find((p) => p.id === connecting);
    if (provider?.configured) {
      controller.listModels();
      setConnecting(null);
    }
  }, [connecting, state.providers]);

  const providerName = (id: string) => state.providers.find((p) => p.id === id)?.name || id;

  const models = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return state.models;
    return state.models.filter((m) =>
      `${m.id} ${m.label || ""} ${(m as any).provider || ""} ${providerName(String((m as any).provider || ""))}`
        .toLowerCase()
        .includes(query),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.models, state.providers, q]);

  // Connected models keep today's behavior (and order) unchanged; anything the
  // node flagged `configured: false` is a per-*provider* summary row (see
  // server.ts publicModelsList — one row per unconnected provider, not one per
  // unconnected model, since Pi's catalog runs to ~1000 models) rendered below
  // as a separate, non-selectable "Other models" section.
  const connectedModels = models.filter((m) => (m as any).configured !== false);
  const otherProviders = models.filter((m) => (m as any).configured === false);

  const isCurrent = (m: ModelInfo) =>
    state.currentModel != null && m.id === state.currentModel.id && (m as any).provider === (state.currentModel as any).provider;

  if (connecting) {
    return (
      <Sheet
        title={providerName(connecting)}
        onClose={onClose}
        headExtra={
          <button className="sheet-back" onClick={() => setConnecting(null)} aria-label="Back">
            ‹
          </button>
        }
      >
        <ProviderConnectForm state={state} providerId={connecting} />
      </Sheet>
    );
  }

  return (
    <Sheet title="Model" onClose={onClose} headExtra={<ReasoningPill state={state} />} autoFocusSearch={false}>
      <input className="picker-search" placeholder="Search models…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="picker-list">
        {connectedModels.length === 0 && otherProviders.length === 0 && <div className="picker-empty">No models available.</div>}
        {connectedModels.map((m) => (
          <PickerItem
            key={`${(m as any).provider || ""}:${m.id}`}
            active={isCurrent(m)}
            title={m.label || m.id}
            meta={modelMeta(m)}
            onClick={() => {
              controller.chooseModel(m);
              onClose();
            }}
          />
        ))}
        {otherProviders.length > 0 && (
          <>
            <div className="picker-section-label">Other models</div>
            {otherProviders.map((m) => {
              const provider = String((m as any).provider || "");
              const name = providerName(provider);
              const count = Number((m as any).modelCount) || 0;
              return (
                <PickerItem
                  key={`${provider}:${m.id}`}
                  title={name}
                  meta={`${count} model${count === 1 ? "" : "s"} · Not connected`}
                  right={
                    <button
                      type="button"
                      className="picker-action"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConnecting(provider);
                      }}
                    >
                      Connect
                    </button>
                  }
                  onClick={() => setConnecting(provider)}
                />
              );
            })}
          </>
        )}
      </div>
    </Sheet>
  );
}
