// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AccountMe, AccountNode, AppState, EphemeralQueueDefault, LocalModelPreset, LocalModelProvider, PairedDevice, GithubAppEntry, GithubAppInfo, GithubQueueItem, NodeSettings, NotificationPreferences, SandboxTier, EphemeralMachine, EphemeralModelKeyInfo, EphemeralPrefs, ProviderKeyInfo, ProviderSize } from "@bivy/core";
import { NOTIFICATION_KIND_META, EPHEMERAL_PROVIDERS, ephemeralAdapter, PRO_PRICE_LABEL } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { PickerItem } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { OauthStep } from "./ProviderConnect.js";
import { GithubQueuePanel } from "./GithubQueue.js";
import { StatsPanel } from "./StatsPanel.js";
import { currentThemeSetting, setTheme, type ThemeSetting } from "../theme.js";
import { useModalEscape } from "../modalStack.js";
import type { SettingsView } from "../router.js";
import { EPHEMERAL_MACHINES_ENABLED } from "../flags.js";

// The view enumeration lives in router.ts (as `SettingsView`) so the router can
// validate a `/settings/:view` path without importing this component module;
// aliased back to `View` here since it's used throughout as local vocabulary.
type View = SettingsView;

/** Sandbox tiers (Codex's vocabulary), shared by the node default + per-session picker. */
export const SANDBOX_TIERS: Array<{ id: SandboxTier; label: string; hint: string }> = [
  { id: "read-only", label: "Read-only", hint: "Read the workspace; no writes, no network." },
  { id: "workspace-write", label: "Workspace write", hint: "Read/write the worktree; escapes need approval." },
  { id: "danger-full-access", label: "Full access", hint: "No in-agent sandbox — the agent can do anything (opt-out)." },
];

// --- Line icons (currentColor, 20px). Kept inline so Settings has no icon-lib
// dependency and each glyph inherits the nav row's ink/muted color. ---
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}
const IconAppearance = () => (
  <Glyph><circle cx="12" cy="12" r="9" /><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor" stroke="none" /></Glyph>
);
const IconKey = () => (
  <Glyph><circle cx="7.5" cy="15.5" r="4.5" /><path d="m11 12 8-8" /><path d="m16 5 3 3" /><path d="m13 8 3 3" /></Glyph>
);
const IconMic = () => (
  <Glyph><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><path d="M12 19v3" /></Glyph>
);
const IconGithub = () => (
  <Glyph><path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" /></Glyph>
);
const IconUser = () => (
  <Glyph><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Glyph>
);
const IconLink = () => (
  <Glyph><path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 0 1 0 10h-2" /><line x1="8" y1="12" x2="16" y2="12" /></Glyph>
);
const IconQueue = () => (
  <Glyph><path d="M4 13h4l2 3h4l2-3h4" /><path d="M5.5 5h13l1.5 8v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4z" /></Glyph>
);
const IconMonitor = () => (
  <Glyph><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></Glyph>
);
const IconServer = () => (
  <Glyph><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></Glyph>
);
const IconBolt = () => (
  <Glyph><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" /></Glyph>
);
const IconCpu = () => (
  <Glyph><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></Glyph>
);
const IconSun = () => (
  <Glyph><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Glyph>
);
const IconMoon = () => (
  <Glyph><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></Glyph>
);
const IconBell = () => (
  <Glyph><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></Glyph>
);

// Display name for a plan id — capitalization only, now that the internal ids
// ("free" | "pro" | "team") match what the marketing site sells. `individual` is
// the pre-rename id for Pro, kept here so an account that somehow escaped the
// boot migration still renders as "Pro" instead of falling through to a raw
// lowercase id. Presentational only; does not touch entitlements.
const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  individual: "Pro",
  team: "Team",
};
function planLabel(plan: string | null | undefined): string {
  if (!plan) return "—";
  return PLAN_LABELS[plan] ?? plan;
}

/**
 * POST the GitHub App manifest to GitHub. The manifest is too large/nested for a
 * query string, so it must ride as a form field — we build a form and submit it,
 * navigating the tab to GitHub's app-creation confirm page. GitHub then redirects
 * back to our origin (`?bivy_github_app=1&code=…&state=…`), which the controller
 * detects on the next load and relays to the node.
 */
// Set just before the browser leaves for GitHub, so the return handler
// recognises the redirect even if GitHub drops our query marker.
function markGithubAppPending(): void {
  try {
    sessionStorage.setItem("bivy.githubAppPending", "1");
  } catch {
    /* ignore */
  }
}

/** Reactive matchMedia — drives the responsive split (mobile drill-in vs.
 *  desktop two-pane) from CSS's own breakpoint so the two never disagree. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof matchMedia === "function" ? matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

type NavItem = { id: View; label: string; icon: ReactNode };
type NavGroup = { label: string; items: NavItem[] };

const TITLES: Record<View, string> = {
  appearance: "Appearance",
  notifications: "Notifications",
  providers: "Keys & OAuth",
  models: "Local models",
  voice: "Voice input",
  github: "GitHub App",
  queue: "GitHub Queue",
  nodes: "Nodes",
  ephemeral: "Ephemeral machines",
  account: "Account & billing",
  link: "Link a device",
};

export function Settings({
  state,
  onClose,
  view,
  onViewChange,
  githubQueue,
  onRefreshGithubQueue,
  onPickSession,
}: {
  state: AppState;
  onClose: () => void;
  /** The active section, driven by the URL (`/settings/:view`) — null is the
   *  mobile root menu (`/settings`). See settingsRoute.ts (#78). */
  view: View | null;
  onViewChange: (view: View | null) => void;
  /** GitHub Queue data + handlers — the queue is now a Settings panel (#388),
   *  not a separate modal. */
  githubQueue?: GithubQueueItem[] | null;
  onRefreshGithubQueue?: () => void;
  onPickSession?: (sessionId: string, path?: string, nodeId?: string) => void;
}) {
  const hosted = !controller.direct;
  // Below the CSS breakpoint we behave like the Claude mobile settings: a root
  // list that drills into a single panel with a back button. At/above it we're
  // the desktop two-pane — nav always visible, a panel always selected.
  const isDesktop = useMediaQuery("(min-width: 721px)");
  const DEFAULT: View = "appearance";
  const [query, setQuery] = useState("");

  // null === the mobile root menu. On desktop we always resolve to a panel —
  // reflect that resolution back into the URL so `/settings` never lingers
  // without a section once there's room to show one.
  const activeView: View | null = view ?? (isDesktop ? DEFAULT : null);
  useEffect(() => {
    if (isDesktop && view === null) onViewChange(DEFAULT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, view]);

  // Escape closes; focus starts inside the panel and restores to the opener on
  // close (parity with the Sheet primitive this replaced).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Escape closes the modal — but only when Settings is the topmost layer.
  // A confirm dialog or sheet opened from within a panel registers above this,
  // so its Escape cancels *it* and leaves Settings open (it used to tear the
  // whole modal down in one press).
  useModalEscape(() => onCloseRef.current());
  // Restore focus to whatever opened Settings when it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => { opener?.focus?.(); };
  }, []);

  const groups: NavGroup[] = [
    {
      label: "General",
      items: [
        { id: "appearance", label: "Appearance", icon: <IconAppearance /> },
        { id: "notifications", label: "Notifications", icon: <IconBell /> },
        { id: "providers", label: "Keys & OAuth", icon: <IconKey /> },
        { id: "models", label: "Local models", icon: <IconCpu /> },
        { id: "voice", label: "Voice input", icon: <IconMic /> },
      ],
    },
    {
      label: "GitHub",
      items: [
        { id: "github", label: "GitHub App", icon: <IconGithub /> },
        { id: "queue", label: "GitHub Queue", icon: <IconQueue /> },
      ],
    },
    {
      label: "Infrastructure",
      items: [
        { id: "nodes", label: "Nodes", icon: <IconServer /> },
        ...(EPHEMERAL_MACHINES_ENABLED
          ? [{ id: "ephemeral" as View, label: "Ephemeral machines", icon: <IconBolt /> }]
          : []),
      ],
    },
  ];
  if (hosted) {
    groups.push({
      label: "Account",
      items: [
        { id: "account", label: "Account & billing", icon: <IconUser /> },
        { id: "link", label: "Link a device", icon: <IconLink /> },
      ],
    });
  }

  const q = query.trim().toLowerCase();
  const matches = (label: string) => !q || label.toLowerCase().includes(q);
  // A query matching nothing used to hide every group and leave the sidebar
  // blank — looked broken rather than "no results" (#140).
  const hasVisibleNavItem = groups.some((group) => group.items.some((it) => matches(it.label)));

  const title = activeView ? TITLES[activeView] : "Settings";

  return createPortal(
    <div className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-scrim" onClick={onClose} />
      <div className="settings-panel" data-mode={activeView ? "panel" : "menu"}>
        <aside className="settings-nav">
          <div className="settings-nav-top">
            <span className="settings-nav-heading">Settings</span>
            <button className="settings-x" onClick={onClose} aria-label="Close settings">×</button>
          </div>
          <div className="settings-search-wrap">
            <svg className="settings-search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              className="settings-search"
              type="search"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <nav className="settings-nav-groups">
            {!hasVisibleNavItem && <div className="picker-empty">No settings match "{query.trim()}"</div>}
            {groups.map((group) => {
              const visible = group.items.filter((it) => matches(it.label));
              if (visible.length === 0) return null;
              return (
                <div className="settings-nav-group" key={group.label}>
                  <div className="settings-nav-group-label">{group.label}</div>
                  {visible.map((it) => (
                    <button
                      key={it.id}
                      className={`settings-nav-item${activeView === it.id ? " active" : ""}`}
                      onClick={() => onViewChange(it.id)}
                    >
                      <span className="settings-nav-icon">{it.icon}</span>
                      <span className="settings-nav-label">{it.label}</span>
                      <span className="settings-nav-chevron" aria-hidden>›</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </nav>
        </aside>

        <section className="settings-content">
          <header className="settings-head">
            {activeView && (
              <button className="settings-back" onClick={() => onViewChange(null)} aria-label="Back to settings">
                <span aria-hidden>‹</span> Settings
              </button>
            )}
            <h2 className="settings-head-title">{title}</h2>
            <button className="settings-x settings-x-content" onClick={onClose} aria-label="Close settings">×</button>
          </header>
          <div className="settings-body">
            {activeView === "appearance" && <AppearancePanel />}
            {activeView === "notifications" && <NotificationsPanel />}
            {activeView === "providers" && <ProvidersPanel state={state} />}
            {activeView === "models" && <LocalModelsPanel state={state} />}
            {activeView === "voice" && <VoicePanel state={state} />}
            {activeView === "github" && <GithubPanel state={state} onOpenGithubQueue={() => onViewChange("queue")} />}
            {activeView === "queue" && (
              <GithubQueuePanel
                queue={githubQueue ?? null}
                onRefresh={() => onRefreshGithubQueue?.()}
                onPick={(id, path, nodeId) => onPickSession?.(id, path, nodeId)}
                onOpenGithubSettings={() => onViewChange("github")}
              />
            )}
            {activeView === "nodes" && <NodesPanel state={state} />}
            {activeView === "ephemeral" && EPHEMERAL_MACHINES_ENABLED && <EphemeralPanel />}
            {activeView === "account" && <AccountPanel />}
            {activeView === "link" && <LinkPanel onDone={onClose} />}
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}

// ---- Appearance (theme) ----
function AppearancePanel() {
  const [setting, setSetting] = useState<ThemeSetting>(currentThemeSetting());
  const options: Array<{ id: ThemeSetting; label: string; icon: ReactNode }> = [
    { id: "system", label: "System", icon: <IconMonitor /> },
    { id: "light", label: "Light", icon: <IconSun /> },
    { id: "dark", label: "Dark", icon: <IconMoon /> },
  ];
  return (
    <div className="settings-form">
      <label className="field-label">Theme</label>
      <div className="theme-seg" role="radiogroup" aria-label="Theme">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={setting === o.id}
            className={`theme-seg-btn${setting === o.id ? " active" : ""}`}
            onClick={() => {
              setTheme(o.id);
              setSetting(o.id);
            }}
          >
            <span className="theme-seg-icon">{o.icon}</span>
            <span className="theme-seg-label">{o.label}</span>
          </button>
        ))}
      </div>
      <p className="muted">Choose how Bivy looks. <strong>System</strong> follows your device's light/dark setting.</p>
    </div>
  );
}

// ---- Reusable switch ----
function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
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

// ---- Notifications (push on/off + per-event choices) ----
function NotificationsPanel() {
  const [status, setStatus] = useState<{ supported: boolean; subscribed: boolean; permission: string } | null>(null);
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadStatus = () => controller.pushStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    reloadStatus();
    controller.getNotificationPreferences().then(setPrefs).catch(() => {});
  }, []);

  // The enable/disable result (or a save error) used to sit there forever —
  // auto-dismiss it like every other transient status message in Settings (#140).
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 5000);
    return () => clearTimeout(t);
  }, [msg]);

  // Push notifications are included on every plan, so there's no upgrade gate.
  const on = Boolean(status?.subscribed);

  const setMaster = async (next: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg(next ? await controller.enablePush() : await controller.disablePush());
    } catch (e) {
      setMsg(String((e as Error).message || e));
    } finally {
      setBusy(false);
      reloadStatus();
    }
  };

  const setKind = (id: (typeof NOTIFICATION_KIND_META)[number]["id"], value: boolean) => {
    if (!prefs) return;
    const next = { ...prefs, [id]: value };
    setPrefs(next); // optimistic
    controller.setNotificationPreferences({ [id]: value }).then(setPrefs).catch((e) => {
      setPrefs(prefs); // revert
      setMsg(String((e as Error).message || e));
    });
  };

  if (status && !status.supported) {
    return (
      <div className="settings-form">
        <p className="muted">Push notifications aren't supported on this device or browser.</p>
      </div>
    );
  }

  return (
    <div className="settings-form">
      <div className="settings-toggle-row">
        <div className="settings-toggle-text">
          <span className="field-label">Push notifications</span>
          <p className="muted">{on ? "This device receives Bivy push notifications." : "Turn on to get notified about your sessions on this device."}</p>
        </div>
        <Toggle checked={on} disabled={busy} onChange={setMaster} label="Enable push notifications" />
      </div>
      {status?.permission === "denied" && (
        <p className="muted">Notifications are blocked in your browser settings — allow them there to enable push.</p>
      )}
      {msg && <p className="muted">{msg}</p>}

      <label className="field-label" style={{ marginTop: 8 }}>What to notify me about</label>
      <div className="settings-toggle-list" aria-disabled={!on}>
        {NOTIFICATION_KIND_META.map((k) => (
          <div className={`settings-toggle-row${on ? "" : " disabled"}`} key={k.id}>
            <div className="settings-toggle-text">
              <span className="settings-toggle-title">{k.label}</span>
              <p className="muted">{k.description}</p>
            </div>
            <Toggle
              checked={prefs ? prefs[k.id] : true}
              disabled={!on || !prefs}
              onChange={(v) => setKind(k.id, v)}
              label={k.label}
            />
          </div>
        ))}
      </div>
      <p className="muted">These choices apply to every device signed in to your account.</p>
    </div>
  );
}

// ---- Providers / OAuth ----

/** Human label for a node, falling back to its id. */
function nodeLabel(nodes: AccountNode[], nodeId: string | null): string {
  if (!nodeId) return "this node";
  return nodes.find((n) => n.id === nodeId)?.name || nodeId;
}

/**
 * One-line summary of a node's OAuth sign-ins, derived from the plaintext
 * per-node provider summary (`AccountNode.providers`) the control plane already
 * holds — so we can describe every node's login state without connecting to it
 * (see docs/credential-sync.md, pushProviderSummaryToControlPlane in
 * src/server.ts). Only OAuth logins are summarized there; API keys still need a
 * live connection to that node, which the switcher makes one tap away.
 */
function nodeProviderSummary(n: AccountNode): { text: string; expired: boolean } {
  const provs = n.providers ?? [];
  const expired = provs.filter((p) => typeof p.expiresAt === "number" && p.expiresAt < Date.now());
  if (provs.length === 0) return { text: "No sign-ins reported", expired: false };
  const parts = [`${provs.length} sign-in${provs.length === 1 ? "" : "s"}`];
  if (expired.length) parts.push(`${expired.length} expired`);
  return { text: parts.join(" · "), expired: expired.length > 0 };
}

function ProvidersPanel({ state }: { state: AppState }) {
  // Holds just the id, not a snapshot of the ProviderInfo object: `managing`
  // below is re-derived from live `state.providers` every render instead, so
  // a remove (whose only signal is an eventual refreshed providers.list —
  // save now awaits a direct ack, see saveApiKey) actually shows up in this
  // detail view (e.g. the "Connected" chip) instead of the view staying
  // frozen on the object as it looked when the user first tapped in.
  // In hosted (relay) mode the account can have several nodes, each with its
  // own provider logins/keys. `state.providers` only ever reflects the node the
  // app is currently connected to, so managing another node's keys used to mean
  // switching nodes somewhere else first. The node switcher below lets the user
  // pick which node's keys this panel shows and edits, without leaving Settings.
  const hosted = !controller.direct;
  const nodes = state.nodes;
  const currentNodeId = state.currentNodeId;
  const showNodePicker = hosted && nodes.length > 1;
  const [managingId, setManagingId] = useState<string | null>(null);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; label?: string; action: () => void }>(null);
  useEffect(() => {
    controller.listProviders();
    // Pull the node list (with each node's plaintext OAuth summary) so the
    // switcher can describe every node's login state up front.
    if (hosted) void controller.refreshNodes();
  }, [hosted]);
  // Switching node reconnects the transport to a different daemon, so the
  // provider list open before the switch belongs to the old node — drop back to
  // the list rather than leaving a stale provider's detail on screen.
  useEffect(() => {
    setManagingId(null);
  }, [currentNodeId]);

  const pickNode = (id: string) => {
    if (id === currentNodeId || switchingTo) return;
    setManagingId(null);
    setSwitchingTo(id);
    // connectToNode switches the transport, waits for the node to come online,
    // then re-lists its providers — so `state.providers` ends up scoped to the
    // picked node with no extra plumbing here.
    controller
      .connectToNode(id)
      .catch(() => {})
      .finally(() => setSwitchingTo(null));
  };

  const managing = managingId ? state.providers.find((p) => p.id === managingId) ?? null : null;
  useEffect(() => {
    if (managing?.configured) controller.getProviderAuth(managing.id);
    // Re-check when `configured` flips true too (e.g. right after a save
    // lands), not just when switching providers.
  }, [managing?.id, managing?.configured]);

  if (managing) {
    const auth = state.providerAuth?.provider === managing.id ? state.providerAuth : null;
    const isOauth = (auth?.kind || managing.kind) === "oauth";
    return (
      <div className="settings-form">
        <button className="link-btn" onClick={() => setManagingId(null)}>
          ‹ All providers
        </button>
        <h3>{managing.name || managing.id}</h3>
        {showNodePicker && <p className="muted small">On node {nodeLabel(nodes, currentNodeId)}.</p>}
        {confirm && (
          <ConfirmDialog
            title={confirm.title}
            message={confirm.message}
            confirmLabel={confirm.label || "Remove"}
            danger
            onCancel={() => setConfirm(null)}
            onConfirm={() => { confirm.action(); setConfirm(null); }}
          />
        )}
        {isOauth ? (
          <>
            <p className="muted">Signed in with a subscription (OAuth).</p>
            <button
              className="btn danger-ghost"
              onClick={() => setConfirm({
                title: "Reset OAuth session?",
                message: `Reset the OAuth session for ${managing.name || managing.id}? You can sign in again afterwards.`,
                label: "Reset",
                action: () => controller.resetOauth(managing.id),
              })}
            >
              Reset OAuth session
            </button>
          </>
        ) : (
          <>
            {state.oauth ? (
              <OauthStep />
            ) : (
              <>
                {managing.oauth && (
                  <button className="btn primary block" onClick={() => controller.startOauth(managing.id)}>
                    Sign in with {managing.name || managing.id}
                  </button>
                )}
                <label className="field-label">API key</label>
                <input className="picker-search" type="password" value={key} placeholder="Paste API key" onChange={(e) => setKey(e.target.value)} />
                <div className="row-actions">
                  <button
                    className="btn primary"
                    disabled={!key.trim() || busy}
                    onClick={async () => {
                      setBusy(true);
                      setKeyErr(null);
                      try {
                        // Awaits the node's real ack instead of a blind timer
                        // that looked saved either way — see #140.
                        await controller.saveApiKey(managing.id, key.trim());
                        setKey("");
                        // Re-list so the "Connected" chip (managing is derived
                        // live from state.providers, see above) reflects it.
                        controller.listProviders();
                      } catch (e) {
                        setKeyErr(String((e as Error)?.message || e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {busy ? "Saving…" : "Save key"}
                  </button>
                  {managing.configured && (
                    <button
                      className="btn danger-ghost"
                      onClick={() => setConfirm({
                        title: "Remove API key?",
                        message: `Remove the stored key for ${managing.name || managing.id}?`,
                        action: () => {
                          controller.removeProvider(managing.id);
                          // provider.remove has no direct ack — re-list so the
                          // "Connected" chip reflects the node's real outcome.
                          setTimeout(() => controller.listProviders(), 500);
                        },
                      })}
                    >
                      Remove
                    </button>
                  )}
                </div>
                {keyErr && <div className="banner error inline">{keyErr}</div>}
              </>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="settings-form">
      {showNodePicker && (
        <>
          <p className="muted settings-intro">
            Keys &amp; OAuth are stored on each node. Pick a node to view and manage its sign-ins — you don't
            need an open session on it.
          </p>
          <label className="field-label">Node</label>
          <div className="picker-list">
            {nodes.map((n) => {
              const summary = nodeProviderSummary(n);
              const active = n.id === currentNodeId;
              const pending = n.id === switchingTo;
              return (
                <PickerItem
                  key={n.id}
                  active={active}
                  disabled={Boolean(switchingTo)}
                  title={n.name || n.id}
                  meta={`${n.online ? "Online" : "Offline"} · ${summary.text}`}
                  right={
                    pending ? (
                      <span className="chip">Connecting…</span>
                    ) : active ? (
                      <span className="chip ok">Managing</span>
                    ) : summary.expired ? (
                      <span className="chip warn">Expired</span>
                    ) : undefined
                  }
                  onClick={() => pickNode(n.id)}
                />
              );
            })}
          </div>
          <label className="field-label">Keys &amp; OAuth on {nodeLabel(nodes, currentNodeId)}</label>
        </>
      )}
      {switchingTo ? (
        <p className="muted">Connecting to {nodeLabel(nodes, switchingTo)}…</p>
      ) : (
        <div className="picker-list">
          {state.providers.length === 0 && <div className="picker-empty">No providers reported.</div>}
          {state.providers.map((p) => (
            <PickerItem
              key={p.id}
              title={p.name || p.id}
              meta={p.configured ? (p.kind === "oauth" ? "OAuth token" : `API key${p.source ? ` · ${p.source}` : ""}`) : "Not connected"}
              right={p.configured ? <span className="chip ok">Connected</span> : undefined}
              onClick={() => setManagingId(p.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Local / custom model endpoints (Ollama, LM Studio, vLLM, Azure, …) ----
// Bivy owns the registry (node: local-model-store.ts) and syncs it across
// devices; this panel is the front door. Any OpenAI-compatible endpoint works.

/** Editable form state for one provider. `models` is a newline list of ids. */
type LocalModelDraft = {
  providerId: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  models: string;
  editing: boolean;
};

const EMPTY_DRAFT: LocalModelDraft = {
  providerId: "",
  name: "",
  baseUrl: "",
  api: "openai-completions",
  apiKey: "",
  models: "",
  editing: false,
};

/** Known API families the endpoint can speak (Pi dispatches on this). */
const KNOWN_APIS: Array<{ value: string; label: string }> = [
  { value: "openai-completions", label: "OpenAI-compatible (Ollama, vLLM, LM Studio, …)" },
  { value: "azure-openai-responses", label: "Azure OpenAI" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
];

/** Parse the models textarea: one `id` or `id | Display Name` per line. */
function parseModelLines(text: string): Array<{ id: string; name?: string }> {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): { id: string; name?: string } => {
      const [rawId, ...rest] = line.split("|");
      const id = (rawId ?? "").trim();
      const name = rest.join("|").trim();
      return { id, ...(name ? { name } : {}) };
    })
    .filter((m) => m.id);
}

function draftFromProvider(p: LocalModelProvider): LocalModelDraft {
  return {
    providerId: p.id,
    name: p.name ?? "",
    baseUrl: p.baseUrl,
    api: p.api || "openai-completions",
    apiKey: "",
    models: p.models.map((m) => (m.name && m.name !== m.id ? `${m.id} | ${m.name}` : m.id)).join("\n"),
    editing: true,
  };
}

function draftFromPreset(p: LocalModelPreset): LocalModelDraft {
  return {
    providerId: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    api: p.api || "openai-completions",
    // Local servers accept any token, so we don't prefill a dummy key — only a
    // real key the user types is stored (in the encrypted vault).
    apiKey: "",
    models: "",
    editing: false,
  };
}

function LocalModelsPanel({ state }: { state: AppState }) {
  const [draft, setDraft] = useState<LocalModelDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; action: () => void }>(null);

  useEffect(() => {
    controller.listLocalModels();
    controller.listLocalModelPresets();
  }, []);

  const set = (patch: Partial<LocalModelDraft>) => setDraft((d) => ({ ...(d ?? EMPTY_DRAFT), ...patch }));
  // Opening a (possibly different) draft always clears a stale error from a
  // previous attempt, so it can't linger on an unrelated endpoint.
  const openDraft = (d: LocalModelDraft | null) => {
    setSaveErr(null);
    setDraft(d);
  };

  if (draft) {
    const canSave = draft.baseUrl.trim().length > 0 && !busy;
    const apiIsKnown = KNOWN_APIS.some((o) => o.value === draft.api);
    const isAzure = draft.api.toLowerCase().startsWith("azure");
    const save = async () => {
      setBusy(true);
      setSaveErr(null);
      try {
        // Awaits the node's real ack instead of a blind timer that closed the
        // form (looking saved) even when the node rejected it — see #140.
        await controller.saveLocalModel({
          providerId: (draft.providerId || draft.name || "local").trim(),
          name: draft.name.trim() || undefined,
          baseUrl: draft.baseUrl.trim(),
          api: draft.api.trim() || "openai-completions",
          // Only send a key when the user typed one, so editing without retyping
          // it doesn't wipe the stored key (the node merges onto the previous spec).
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
          models: parseModelLines(draft.models),
        });
        controller.listLocalModels();
        setDraft(null);
      } catch (e) {
        setSaveErr(String((e as Error)?.message || e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="settings-form">
        <button className="link-btn" onClick={() => openDraft(null)}>‹ All endpoints</button>
        <h3>{draft.editing ? draft.name || draft.providerId : "Add endpoint"}</h3>
        <p className="muted">
          Any OpenAI-compatible server — Ollama, LM Studio, vLLM, SGLang, or a self-hosted / Azure endpoint.
        </p>
        <p className="muted small">
          This endpoint is account-wide, not just this node: it syncs (encrypted) to every node signed in to your
          account, the same way provider keys do. A <code>localhost</code> base URL only resolves on the machine
          that has it — another node can use it only if it also runs the same server at that address locally. If
          the server is reachable over the network, point the base URL at that machine's address instead.
        </p>

        <label className="field-label">Display name</label>
        <input className="picker-search" value={draft.name} placeholder="My local models" onChange={(e) => set({ name: e.target.value })} />

        <label className="field-label">Identifier</label>
        <input
          className="picker-search"
          value={draft.providerId}
          placeholder="ollama"
          disabled={draft.editing}
          onChange={(e) => set({ providerId: e.target.value })}
        />

        <label className="field-label">Base URL</label>
        <input
          className="picker-search"
          value={draft.baseUrl}
          placeholder={isAzure ? "https://YOUR-RESOURCE.openai.azure.com" : "http://localhost:11434/v1"}
          onChange={(e) => set({ baseUrl: e.target.value })}
        />
        {/localhost|127\.0\.0\.1/i.test(draft.baseUrl) && (
          <p className="muted small">
            ⚠ This points at the current node's own machine. Once synced, other nodes will only reach it if they
            also run a server at <code>{draft.baseUrl.match(/localhost|127\.0\.0\.1/i)?.[0] ?? "localhost"}</code>
            {" "}themselves.
          </p>
        )}

        <label className="field-label">API type</label>
        <select
          className="picker-search"
          value={apiIsKnown ? draft.api : "__custom__"}
          onChange={(e) => set({ api: e.target.value === "__custom__" ? "" : e.target.value })}
        >
          {KNOWN_APIS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          <option value="__custom__">Custom…</option>
        </select>
        {!apiIsKnown && (
          <input className="picker-search" value={draft.api} placeholder="custom-api-id" onChange={(e) => set({ api: e.target.value })} />
        )}

        <label className="field-label">API key {draft.editing ? "(leave blank to keep)" : isAzure ? "(Azure API key)" : "(optional)"}</label>
        <input className="picker-search" type="password" value={draft.apiKey} placeholder={isAzure ? "Azure OpenAI key" : "local"} onChange={(e) => set({ apiKey: e.target.value })} />

        <label className="field-label">Models — one per line (<code>id</code> or <code>id | Name</code>)</label>
        <textarea
          className="picker-search"
          rows={4}
          value={draft.models}
          placeholder={isAzure ? "my-gpt-4o-deployment | GPT-4o" : "llama3.1\nqwen2.5-coder | Qwen 2.5 Coder"}
          onChange={(e) => set({ models: e.target.value })}
        />
        {isAzure && (
          <p className="muted">
            Azure routes by <em>deployment</em>: set each model’s id to your deployment name. The key is sent as the
            <code> api-key</code> header and <code>api-version</code> is handled automatically.
          </p>
        )}

        <div className="row-actions">
          <button className="btn primary" disabled={!canSave} onClick={save}>
            {busy ? "Saving…" : draft.editing ? "Save changes" : "Add endpoint"}
          </button>
          <button className="btn" onClick={() => openDraft(null)}>Cancel</button>
        </div>
        {saveErr && <div className="banner error inline">{saveErr}</div>}
      </div>
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
        Endpoints here sync to every node signed in to your account, the same as provider keys — they aren't scoped
        to just this node. A <code>localhost</code> base URL is only reachable from the machine that has it, so an
        endpoint like Ollama's default needs that same server running on each node that should use it.
      </p>

      <div className="picker-list">
        {state.localModels.length === 0 && <div className="picker-empty">No local or custom endpoints yet.</div>}
        {state.localModels.map((p) => (
          <PickerItem
            key={p.id}
            title={p.name || p.id}
            meta={`${p.baseUrl} · ${p.modelCount} model${p.modelCount === 1 ? "" : "s"}${p.hasKey ? " · key" : ""}`}
            right={
              <button
                className="btn danger-ghost sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirm({
                    title: "Remove endpoint?",
                    message: `Remove ${p.name || p.id}? This also removes its models.`,
                    action: () => {
                      controller.removeLocalModel(p.id);
                      setTimeout(() => controller.listLocalModels(), 400);
                    },
                  });
                }}
              >
                Remove
              </button>
            }
            onClick={() => openDraft(draftFromProvider(p))}
          />
        ))}
      </div>

      <button className="btn primary block" onClick={() => openDraft({ ...EMPTY_DRAFT })}>+ Add endpoint</button>

      {state.localModelPresets.length > 0 && (
        <>
          <label className="field-label">Quick add</label>
          <div className="row-actions" style={{ flexWrap: "wrap" }}>
            {state.localModelPresets.map((preset) => (
              <button key={preset.id} className="btn" title={preset.note} onClick={() => openDraft(draftFromPreset(preset))}>
                {preset.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Voice input (speech-to-text) ----
function VoicePanel({ state }: { state: AppState }) {
  const [keys, setKeys] = useState<Record<string, string>>({});
  // Keyed by provider id, not a single shared flag — saving one provider's key
  // used to disable Save for every other row too (#140).
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errById, setErrById] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<null | { title: string; message: string; action: () => void }>(null);
  useEffect(() => {
    controller.getSttConfig();
  }, []);
  const config = state.sttConfig;
  const providers = config?.providers ?? [];

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
        Dictate into the composer with the mic button. With a key set, recordings are transcribed by your chosen
        provider using the key stored on this node. With no key, voice falls back to your browser's built-in dictation
        (no key needed, but lower accuracy). Note: <strong>Groq</strong> (fast Whisper hosting, key from console.groq.com)
        is a different company from <strong>xAI / Grok</strong> — an xAI key won't work here, and xAI has no speech API.
      </p>

      <label className="field-label">Preferred provider</label>
      <div className="seg-row">
        {providers.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`seg-btn${config?.provider === p.id ? " active" : ""}`}
            onClick={() => controller.setSttProvider(p.id)}
          >
            {p.label}
          </button>
        ))}
        {providers.length === 0 && <span className="muted">Loading…</span>}
      </div>

      {providers.map((p) => (
        <div key={p.id} className="voice-provider">
          <div className="voice-provider-head">
            <span className="field-label">{p.label}</span>
            {p.configured ? <span className="chip ok">Key set</span> : <span className="chip">No key</span>}
          </div>
          <div className="muted small">{p.model}</div>
          <div className="row-actions">
            <input
              className="picker-search"
              type="password"
              value={keys[p.id] || ""}
              placeholder={p.configured ? "Replace API key" : "Paste API key"}
              onChange={(e) => setKeys((k) => ({ ...k, [p.id]: e.target.value }))}
            />
          </div>
          <div className="row-actions">
            <button
              className="btn primary"
              disabled={!(keys[p.id] || "").trim() || busyId === p.id}
              onClick={async () => {
                setBusyId(p.id);
                setErrById((e) => ({ ...e, [p.id]: "" }));
                try {
                  // Awaits the node's real ack instead of a blind timer — see #140.
                  await controller.saveSttKey(p.id, (keys[p.id] || "").trim());
                  setKeys((k) => ({ ...k, [p.id]: "" }));
                  // "Key set" chip is reactive off state.sttConfig — refresh it.
                  controller.getSttConfig();
                } catch (e) {
                  setErrById((cur) => ({ ...cur, [p.id]: String((e as Error)?.message || e) }));
                } finally {
                  setBusyId(null);
                }
              }}
            >
              {busyId === p.id ? "Saving…" : "Save key"}
            </button>
            {p.configured && (
              <button
                className="btn danger-ghost"
                onClick={() => setConfirm({
                  title: "Remove speech key?",
                  message: `Remove the stored ${p.label} key?`,
                  action: () => {
                    controller.removeSttKey(p.id);
                    // stt.config.set (remove) has no direct ack — re-fetch so
                    // the "Key set" chip reflects the node's real outcome.
                    setTimeout(() => controller.getSttConfig(), 500);
                  },
                })}
              >
                Remove
              </button>
            )}
          </div>
          {errById[p.id] && <div className="banner error inline">{errById[p.id]}</div>}
        </div>
      ))}
    </div>
  );
}

// ---- GitHub App ----
function GithubPanel({ state, onOpenGithubQueue }: { state: AppState; onOpenGithubQueue?: () => void }) {
  const [org, setOrg] = useState("");
  // Connected-app info comes from the control plane (account REST), so it's
  // only available on the hosted/relay client, not direct mode.
  const canQuery = !controller.direct;
  const [info, setInfo] = useState<GithubAppInfo | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<GithubAppEntry | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  // Keyed by app so an error stays attached to the row it belongs to.
  const [disconnectErr, setDisconnectErr] = useState<{ id: string; message: string } | null>(null);
  const [nodes, setNodes] = useState<AccountNode[]>([]);
  const [defaultNode, setDefaultNode] = useState("");
  const [savingDefaultNode, setSavingDefaultNode] = useState(false);
  const [defaultNodeMsg, setDefaultNodeMsg] = useState<string | null>(null);
  // "Connect an existing GitHub App" (App ID + .pem) — for reconnecting an app
  // this account already set up onto the active node, without creating a new one.
  // `ceApp` is the connected app the form was opened for (null = a fresh app the
  // account doesn't know yet); it decides where the form renders and what it pre-fills.
  const [showConnectExisting, setShowConnectExisting] = useState(false);
  const [ceApp, setCeApp] = useState<GithubAppEntry | null>(null);
  const [ceAppId, setCeAppId] = useState("");
  const [cePem, setCePem] = useState("");
  const [ceNodeLabel, setCeNodeLabel] = useState("");
  // Once at least one app is connected, "add another" is a secondary action —
  // collapse it behind a button instead of always showing the full form, so
  // the common case (you already have an app) isn't buried under it.
  const [addAppOpen, setAddAppOpen] = useState(false);
  // Ephemeral-runner default: auto-provision a short-lived server to pick up
  // queued work when nothing persistent is online. Moved here from the GitHub
  // Queue panel — it's account-level GitHub-App config, not per-queue state.
  const [ephemeralKeys, setEphemeralKeys] = useState<ProviderKeyInfo[]>([]);
  const [ephemeralDefault, setEphemeralDefault] = useState<EphemeralQueueDefault | null>(null);
  const [ephemeralBusy, setEphemeralBusy] = useState(false);
  const [ephemeralErr, setEphemeralErr] = useState<string | null>(null);
  const app = state.githubApp;
  const phase = app?.phase ?? "idle";
  // Identity for list keys and per-row busy/error state. Hooks created before
  // Bivy recorded App IDs have neither appId nor slug — fall back to the hook id.
  const appKey = (entry: GithubAppEntry) => entry.appId || entry.hookId || entry.slug || "";
  const installHref = (entry: GithubAppEntry) =>
    entry.installUrl || (entry.slug ? `https://github.com/apps/${entry.slug}/installations/new` : "https://github.com/settings/installations");
  // Opening the reconnect form for a different app moves it rather than closing it.
  const toggleConnectExisting = (entry?: GithubAppEntry) => {
    const target = entry ?? null;
    const sameApp = showConnectExisting && (ceApp ? appKey(ceApp) : "") === (target ? appKey(target) : "");
    setShowConnectExisting(!sameApp);
    setCeApp(target);
    setCeAppId(target?.appId ?? "");
  };
  const submitConnectExisting = () => {
    controller.githubAppConnectExisting({ appId: ceAppId.trim(), privateKeyPem: cePem.trim(), nodeLabel: ceNodeLabel.trim() || undefined });
  };
  // Read a downloaded .pem file straight into the field, so the user never has to
  // open + copy it — the closest thing to a "flow" GitHub allows for an app that
  // already exists (it never hands the private key back through a redirect).
  const onPemFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCePem(String(reader.result || "").trim());
    reader.readAsText(file);
  };
  const renderConnectExisting = () => (
    <div className="ce-form">
      {ceApp?.editUrl && (
        <p className="muted">
          Get these from your app on GitHub:{" "}
          <a href={ceApp.editUrl} target="_blank" rel="noopener noreferrer">
            open {ceApp.mention ? `@${ceApp.mention}` : "the app"}’s settings →
          </a>{" "}
          — the App ID is at the top; scroll to <em>Private keys → Generate a private key</em> to download the .pem.
        </p>
      )}
      <label className="field-label">App ID</label>
      <input className="picker-search" value={ceAppId} placeholder="e.g. 123456" onChange={(e) => setCeAppId(e.target.value)} />
      <label className="field-label">Private key (.pem)</label>
      <input className="ce-file" type="file" accept=".pem,application/x-pem-file,text/plain" onChange={onPemFile} />
      <textarea
        className="picker-search ce-pem"
        value={cePem}
        rows={4}
        placeholder="…or paste it here: -----BEGIN RSA PRIVATE KEY----- … -----END RSA PRIVATE KEY-----"
        onChange={(e) => setCePem(e.target.value)}
      />
      <label className="field-label">Pin to this node's label (optional)</label>
      <input
        className="picker-search"
        value={ceNodeLabel}
        placeholder="e.g. hetzner → this node serves bivy/hetzner"
        onChange={(e) => setCeNodeLabel(e.target.value)}
      />
      <p className="muted">
        The key stays on this node; the app's existing webhook keeps working (the account's hook is reused).
      </p>
      <div className="row-actions">
        <button
          className="btn primary"
          disabled={!ceAppId.trim() || !cePem.trim() || phase === "completing"}
          onClick={submitConnectExisting}
        >
          {phase === "completing" ? "Connecting…" : "Connect app to this node"}
        </button>
      </div>
      {phase === "completing" && <p className="muted">Verifying the key with GitHub on the node…</p>}
      {phase === "done" && <div className="banner info inline">✓ Connected on this node — its webhook keeps working, nothing else to do.</div>}
      {phase === "error" && <div className="banner error inline">{app?.error || "Could not connect the app."}</div>}
    </div>
  );
  // Two steps by design: the first tap fetches the manifest from the node (an
  // async relay round-trip); the second is a **native form submit** to GitHub.
  // A real <form> + <button type="submit"> (not a scripted form.submit()) is the
  // most reliable top-level cross-origin POST — installed/standalone PWAs on iOS
  // routinely drop scripted navigations but honour a genuine submit gesture.
  const ready = phase === "submitting" && app?.action && app?.manifest;

  const refresh = () => {
    if (!canQuery) return;
    controller.fetchGithubApp().then(setInfo).catch(() => setInfo(null));
    controller.listNodes().then(setNodes).catch(() => {});
    controller.listEphemeralKeys().then(setEphemeralKeys).catch(() => {});
    controller.getEphemeralQueueDefault().then(setEphemeralDefault).catch(() => setEphemeralDefault(null));
  };
  useEffect(refresh, []);
  // Re-pull once the create flow reports success, so "connected" appears without
  // a manual reload.
  useEffect(() => {
    if (phase === "done") refresh();
  }, [phase]);
  const apps = info?.apps ?? [];
  // The default node is one account-level setting written to every app, so any
  // app that has it answers for all of them.
  const storedDefaultNode = apps.find((a) => a.defaultNode)?.defaultNode ?? "";
  // Seed the editable field from the account's stored default whenever it
  // changes (initial load, or after a save round-trip elsewhere).
  useEffect(() => { setDefaultNode(storedDefaultNode); }, [storedDefaultNode]);

  // The apps share the same routing copy; show the first one's handle as the example.
  const primaryMention = apps.find((a) => a.mention)?.mention;
  const configuredProviders = ephemeralKeys.filter((k) => k.configured);
  const defaultProviderConfigured = Boolean(
    ephemeralDefault?.provider && ephemeralKeys.find((k) => k.id === ephemeralDefault.provider)?.configured,
  );
  const saveEphemeralDefault = async (patch: Partial<EphemeralQueueDefault>) => {
    setEphemeralErr(null);
    setEphemeralBusy(true);
    try {
      setEphemeralDefault(await controller.setEphemeralQueueDefault(patch));
    } catch (e) {
      setEphemeralErr(String((e as Error)?.message || e));
    } finally {
      setEphemeralBusy(false);
    }
  };
  const saveDefaultNode = async () => {
    setDefaultNodeMsg(null);
    setSavingDefaultNode(true);
    try {
      const saved = await controller.setGithubAppDefaultNode(defaultNode.trim());
      setInfo((cur) => (cur ? { ...cur, defaultNode: saved, apps: cur.apps.map((a) => ({ ...a, defaultNode: saved })) } : cur));
      setDefaultNodeMsg("Saved");
      setTimeout(() => setDefaultNodeMsg(null), 1500);
    } catch (e) {
      setDefaultNodeMsg(String((e as Error)?.message || e));
    } finally {
      setSavingDefaultNode(false);
    }
  };
  const disconnect = async (entry: GithubAppEntry) => {
    const id = appKey(entry);
    setDisconnectErr(null);
    setDisconnectingId(id);
    try {
      await controller.githubAppDisconnect(entry.appId, entry.hookId);
      // Re-read the truth rather than optimistically dropping the row: if the hook
      // is really gone the app leaves the list; if not, say so.
      const next = await controller.fetchGithubApp();
      setInfo(next);
      if (next.apps.some((a) => appKey(a) === id)) {
        setDisconnectErr({ id, message: "Disconnect didn't take effect. The control plane may be mid-deploy — try again shortly." });
      } else {
        // The reconnect form may have been open for the app that just went away.
        if (ceApp && appKey(ceApp) === id) {
          setShowConnectExisting(false);
          setCeApp(null);
        }
        refresh();
      }
    } catch (e) {
      setDisconnectErr({ id, message: String((e as Error)?.message || e) });
    } finally {
      setDisconnectingId(null);
    }
  };
  const renderEphemeral = () => (
    <>
      <div className="settings-toggle-row">
        <div className="settings-toggle-text">
          <span className="settings-toggle-title">Auto-provision when nothing's online</span>
          <span className="muted small">
            Spin up a short-lived server from your saved provider token to pick up queued work when nothing
            persistent is online, then tear it down.
          </span>
        </div>
        <Toggle
          checked={Boolean(ephemeralDefault?.enabled)}
          disabled={ephemeralBusy || configuredProviders.length === 0}
          onChange={(v) => saveEphemeralDefault({ enabled: v, provider: ephemeralDefault?.provider || configuredProviders[0]?.id })}
          label="Auto-provision an ephemeral server when nothing's online"
        />
      </div>
      {configuredProviders.length === 0 ? (
        <p className="muted">Add a Fly.io or Hetzner token in Ephemeral settings to enable this.</p>
      ) : (
        ephemeralDefault?.enabled && (
          <>
            <select
              className="picker-search"
              value={ephemeralDefault.provider ?? ""}
              onChange={(e) => saveEphemeralDefault({ provider: e.target.value })}
            >
              {configuredProviders.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {!defaultProviderConfigured && (
              <p className="muted">This device has no saved token for {ephemeralDefault.provider} — add one in Ephemeral settings to actually help out.</p>
            )}
            {ephemeralErr && <span className="chip err">{ephemeralErr}</span>}
          </>
        )
      )}
    </>
  );
  const renderApp = (entry: GithubAppEntry) => (
    <div className="gh-connected" key={appKey(entry)}>
      <div className="gh-connected-head">
        <span className="gh-connected-status">✓ Connected</span>
        <strong className="gh-connected-name">{entry.name}</strong>
        {/* Which GitHub account this app covers. With several connected, the app
            names alone are easy to confuse; the owner is what tells them apart. */}
        {entry.owner ? (
          <span className="gh-connected-owner">
            {entry.ownerType === "Organization" ? "org" : "personal"} · {entry.owner}
          </span>
        ) : null}
        {entry.editUrl ? (
          <a className="gh-connected-edit" href={entry.editUrl} target="_blank" rel="noopener noreferrer">
            Edit on GitHub →
          </a>
        ) : null}
      </div>
      {entry.mention ? (
        <p className="gh-connected-hint">
          Trigger it in an issue comment with <code>@{entry.mention}</code>
        </p>
      ) : null}
      {entry.installed === false ? (
        <p className="banner warn inline gh-connected-hint">
          ⚠ Not installed on any repository — the app can't receive issues or comments until you install it.{" "}
          <a href={installHref(entry)} target="_blank" rel="noopener noreferrer">
            Install it now →
          </a>
        </p>
      ) : (
        <p className="gh-connected-hint">
          {entry.installed
            ? `Installed on ${entry.installCount} ${entry.installCount === 1 ? "repository/org" : "repositories/orgs"}. Nothing happening?`
            : "Nothing happening? The app only receives events from repos it's installed on."}{" "}
          <a href={installHref(entry)} target="_blank" rel="noopener noreferrer">
            {entry.installed ? "Add / manage repositories →" : "Install / add repositories →"}
          </a>
        </p>
      )}
      {/* The account has the app set up, but no online node holds its key — so
          nothing can run its queue. Offer to (re)connect it on the active node. */}
      {entry.servedBy === null ? (
        <div className="banner warn inline gh-serving-banner">
          ⚠ No online node is running this app right now — queued work won't be picked up. Connect it on a node (this
          account already has the app, so just add its key here).{" "}
          <button className="link-btn" onClick={() => toggleConnectExisting(entry)}>
            {showConnectExisting && ceApp && appKey(ceApp) === appKey(entry) ? "Hide" : "Connect on this node →"}
          </button>
        </div>
      ) : (
        entry.servedBy && (
          <p className="gh-connected-hint">
            Served by <strong>{entry.servedBy.name || entry.servedBy.id}</strong>
            {entry.servedBy.online ? "" : " (offline)"}.
          </p>
        )
      )}
      {showConnectExisting && ceApp && appKey(ceApp) === appKey(entry) && renderConnectExisting()}
      <div className="row-actions">
        <button
          className="btn danger-ghost"
          disabled={disconnectingId !== null}
          onClick={() => setConfirmDisconnect(entry)}
        >
          {disconnectingId === appKey(entry) ? "Disconnecting…" : "Disconnect"}
        </button>
      </div>
      {disconnectErr?.id === appKey(entry) && <div className="banner error inline">{disconnectErr.message}</div>}
    </div>
  );
  // The create + "connect an app you already have" pair. Always available: an
  // account needs one app per GitHub owner, so "add another" is a normal action,
  // not something reserved for the empty state.
  const renderAddApp = () => (
    <>
      <label className="field-label">Organization (optional — leave blank for your personal account)</label>
      <input
        className="picker-search"
        value={org}
        placeholder="my-org"
        disabled={phase === "starting" || phase === "submitting" || phase === "completing"}
        onChange={(e) => setOrg(e.target.value)}
      />
      {ready ? (
        <form method="post" action={app!.action} onSubmit={markGithubAppPending}>
          <input type="hidden" name="manifest" value={JSON.stringify(app!.manifest)} />
          <button className="btn primary block" type="submit">
            Continue to GitHub →
          </button>
        </form>
      ) : (
        <button
          className="btn primary"
          disabled={phase === "starting" || phase === "completing"}
          onClick={() => controller.githubAppManifestStart(org.trim() || undefined)}
        >
          {phase === "starting" ? "Preparing…" : phase === "completing" ? "Finishing…" : "Create GitHub App"}
        </button>
      )}
      {/* Both flows share one phase machine, so suppress the create-flow status
          while the reconnect form (which reports the same phases) is the one running. */}
      {!showConnectExisting && phase === "completing" && <p className="muted">Exchanging the code on the node…</p>}
      {!showConnectExisting && phase === "done" && (
        <div className="banner info inline">
          ✓ App created — the key is stored on this node. <strong>One step left:</strong> the app won't
          receive any issues or comments until you install it on a repo.{" "}
          <a href={app?.installUrl || "https://github.com/settings/installations"} target="_blank" rel="noopener noreferrer">
            Install it on your repositories →
          </a>
        </div>
      )}
      {!showConnectExisting && phase === "error" && <div className="banner error inline">{app?.error || "GitHub App setup failed."}</div>}

      <h4 className="settings-subhead">Already have a GitHub App?</h4>
      <p className="muted">
        Connect an app you already created (e.g. on another node) by adding its App ID + private key here — no need to
        create a duplicate.{" "}
        <button className="link-btn" onClick={() => toggleConnectExisting()}>
          {showConnectExisting && !ceApp ? "Hide" : "Connect existing app →"}
        </button>
      </p>
      {showConnectExisting && !ceApp && renderConnectExisting()}
    </>
  );
  const hasApps = apps.length > 0;
  return (
    <div className="settings-form">
      {confirmDisconnect && (
        <ConfirmDialog
          title="Disconnect GitHub App?"
          message={
            confirmDisconnect.appId
              ? "This node stops handling this app and its key is wiped here. It does not delete the app on GitHub — do that from GitHub's app settings if you want it gone entirely."
              : "This app was set up before Bivy recorded App IDs, so it can only be disconnected together with every other app on this account. Nothing is deleted on GitHub."
          }
          confirmLabel="Disconnect"
          danger
          onCancel={() => setConfirmDisconnect(null)}
          onConfirm={() => { const entry = confirmDisconnect; setConfirmDisconnect(null); disconnect(entry); }}
        />
      )}

      {hasApps && <section className="settings-section">{apps.map(renderApp)}</section>}

      <section className="settings-section">
        <h4 className="settings-subhead">{hasApps ? "Add another app" : "Add an app"}</h4>
        <p className="muted">
          {hasApps
            ? "A GitHub App can only be installed on the account that owns it, so add one per personal account or organization you want Bivy to work in. Each gets its own webhook, and its key is created and kept on this node."
            : "Bivy reaches GitHub through an app you own: one webhook covering every repo you install it on, with replies posting as the app. The private key is created and kept on this node; the control plane only ever sees the webhook signing secret. An app can only be installed on the account that owns it, so add one per personal account or organization."}
        </p>
        {hasApps && !addAppOpen ? (
          <div className="row-actions">
            <button className="btn" onClick={() => setAddAppOpen(true)}>+ Add another GitHub App</button>
          </div>
        ) : (
          <>
            {renderAddApp()}
            {hasApps && (
              <div className="row-actions">
                <button className="link-btn" onClick={() => setAddAppOpen(false)}>Cancel</button>
              </div>
            )}
          </>
        )}
      </section>

      {hasApps && (
        <>
          <section className="settings-section">
            <h4 className="settings-subhead">Default node</h4>
            <p className="muted">
              Untagged issues and <code>@{primaryMention || "mention"}</code> comments route to the shared <code>bivy</code> queue,
              where any online node may claim them. Pick a default node so that work lands on one machine instead — it must
              match the label that node serves (its name below, or whatever it was started with via <code>--node-label</code>).
              One setting for the whole account: it applies to every app above.
            </p>
            {nodes.length > 0 ? (
              <select className="picker-search" value={defaultNode} onChange={(e) => setDefaultNode(e.target.value)}>
                <option value="">Shared queue (any online node)</option>
                {nodes.map((n) => (
                  <option key={n.id} value={n.name || n.id}>{n.name || n.id}</option>
                ))}
                {defaultNode && !nodes.some((n) => (n.name || n.id) === defaultNode) && (
                  <option value={defaultNode}>{defaultNode}</option>
                )}
              </select>
            ) : (
              <input
                className="picker-search"
                value={defaultNode}
                placeholder="node label, e.g. macbook"
                onChange={(e) => setDefaultNode(e.target.value)}
              />
            )}
            <div className="row-actions">
              <button className="btn primary" disabled={savingDefaultNode} onClick={saveDefaultNode}>
                {savingDefaultNode ? "Saving…" : "Save"}
              </button>
              {defaultNodeMsg && <span className="chip ok">{defaultNodeMsg}</span>}
            </div>
          </section>

          <section className="settings-section">
            <h4 className="settings-subhead">Routing labels</h4>
            <p className="muted">Label a GitHub issue (or use the directive in a comment/description) to route it:</p>
            <ul className="settings-list">
              <li><code>bivy</code> — shared queue: the default node above, or any online node if none is set.</li>
              <li><code>bivy/&lt;node&gt;</code> — a specific node's label, e.g. <code>bivy/macbook</code>.</li>
              <li><code>@{primaryMention || "bivy"} on &lt;node&gt;</code> — in a comment or the issue body, same effect as the label.</li>
            </ul>
          </section>

          {EPHEMERAL_MACHINES_ENABLED && (
            <section className="settings-section">
              <h4 className="settings-subhead">Ephemeral runner</h4>
              {renderEphemeral()}
            </section>
          )}
        </>
      )}

      {canQuery && onOpenGithubQueue && (
        <section className="settings-section">
          <h4 className="settings-subhead">Incoming queue</h4>
          <p className="muted">
            Pending, picked-up, and finished GitHub work now has its own screen instead of a list here.
          </p>
          <button className="btn" onClick={onOpenGithubQueue}>
            Open GitHub Queue →
          </button>
        </section>
      )}
    </div>
  );
}

// ---- Nodes (per-node defaults) ----
function NodesPanel({ state }: { state: AppState }) {
  const hosted = !controller.direct;
  const [nodes, setNodes] = useState<Awaited<ReturnType<typeof controller.listNodes>>>([]);
  const [form, setForm] = useState<NodeSettings | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const currentNodeId = controller.local.cur;

  const reload = () => {
    controller.getNodeSettings();
    if (hosted) controller.listNodes().then(setNodes).catch(() => {});
  };
  useEffect(reload, [hosted]);

  // The node whose settings we're editing is only ever the one the transport
  // is actually connected to (`state.status === "online"`) — never a guess
  // based on a fixed timeout. While it's offline/connecting, don't trust
  // whatever is left in `state.nodeSettings` (a prior node's data, or none).
  const nodeOnline = state.status === "online";
  useEffect(() => {
    if (hosted && nodeOnline) controller.getNodeSettings();
  }, [hosted, nodeOnline, currentNodeId]);

  // Re-seed the editable form whenever fresh settings arrive from the node
  // (initial load, or after switching to a different node). Keyed on the node
  // name so an in-progress edit isn't clobbered by an unrelated re-render.
  const settings = nodeOnline ? state.nodeSettings : null;
  // Includes githubIssuePrompt so `resetIssuePrompt` (which doesn't touch the
  // rest of the form) re-seeds once the node echoes back the restored default.
  const sig = settings ? `${settings.name}|${settings.defaultAgent}|${settings.githubIssuePrompt}` : "";
  useEffect(() => { setForm(settings); }, [sig]);

  const runtimes = state.runtimes.filter((r) => String((r as { status?: string }).status ?? "available") === "available");
  const agentCaps = state.runtimes.find((r) => r.id === form?.defaultAgent)?.capabilities as { modelSelection?: boolean } | undefined;
  const modelSelectable = agentCaps?.modelSelection !== false;
  const models = state.models;

  const save = async () => {
    if (!form || saving) return;
    setSaving(true);
    setSaveErr(null);
    setSavedMsg(null);
    try {
      // setNodeSettings now resolves once the node actually acks the change
      // (or rejects with its error) instead of assuming success the moment
      // the command was sent — see #140.
      await controller.setNodeSettings({
        name: form.name,
        defaultAgent: form.defaultAgent,
        defaultModel: modelSelectable ? form.defaultModel : null,
        defaultSandbox: form.defaultSandbox,
        githubMaxConcurrent: form.githubMaxConcurrent,
        githubIssuePrompt: form.githubIssuePrompt,
        sessionSync: form.sessionSync,
        worktreeSync: form.worktreeSync,
        syncStandbyNodeId: form.syncStandbyNodeId ?? "",
      });
      setSavedMsg("Saved");
      setTimeout(() => setSavedMsg(null), 1500);
    } catch (e) {
      setSaveErr(String((e as Error)?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const resetIssuePrompt = () => {
    if (!form || !settings) return;
    setSaveErr(null);
    controller
      .setNodeSettings({ githubIssuePrompt: "" })
      .then(reload)
      .catch((e) => setSaveErr(String((e as Error)?.message || e)));
  };

  return (
    <div className="settings-form">
      <p className="muted settings-intro">
        Per-node defaults for new sessions plus a cap on how many GitHub-triggered sessions run at once.
        {hosted ? " Settings apply to the node you're connected to — pick another below to edit it." : ""}
      </p>

      <div className="row-actions">
        <button className="btn" onClick={() => setStatsOpen(true)}>
          View node stats →
        </button>
      </div>
      {statsOpen && <StatsPanel onClose={() => setStatsOpen(false)} />}

      {hosted && (
        <section className="settings-section">
          <h4 className="settings-subhead">Node</h4>
          <div className="picker-list">
            {nodes.length === 0 && <div className="picker-empty">No nodes found.</div>}
            {nodes.map((n) => (
              <PickerItem
                key={n.id}
                active={n.id === currentNodeId}
                title={n.name || n.id}
                meta={n.online ? "Online" : "Offline"}
                right={n.id === currentNodeId ? <span className="chip ok">Editing</span> : undefined}
                onClick={() => {
                  if (n.id === currentNodeId) return;
                  controller.switchNode(n.id);
                  // Don't show the outgoing node's settings a moment longer than
                  // necessary. The effect above pulls the new node's settings
                  // once the transport actually confirms it's online — no fixed
                  // timeout guess, and no window where a picked *offline* node
                  // would keep displaying whatever was left over from before.
                  setForm(null);
                }}
              />
            ))}
          </div>
        </section>
      )}

      {!nodeOnline ? (
        <p className="muted">
          {state.status === "offline"
            ? "This node is offline — its settings aren't reachable until it reconnects."
            : "Connecting to this node…"}
        </p>
      ) : !form ? (
        <p className="muted">Loading node settings…</p>
      ) : (
        <>
          <section className="settings-section">
            <h4 className="settings-subhead">Identity</h4>
            <label className="field-label">Node name</label>
            <input
              className="picker-search"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="My Mac"
            />
          </section>

          <section className="settings-section">
            <h4 className="settings-subhead">Session defaults</h4>
            <label className="field-label">Default agent</label>
            <select
              className="picker-search"
              value={form.defaultAgent}
              onChange={(e) => setForm({ ...form, defaultAgent: e.target.value })}
            >
              {runtimes.map((r) => (
                <option key={r.id} value={r.id}>{r.displayName || r.name || r.id}</option>
              ))}
              {!runtimes.some((r) => r.id === form.defaultAgent) && (
                <option value={form.defaultAgent}>{form.defaultAgent}</option>
              )}
            </select>

            <label className="field-label">Default model</label>
            {modelSelectable ? (
              <select
                className="picker-search"
                value={form.defaultModel ? form.defaultModel.id : ""}
                onChange={(e) => {
                  const m = models.find((x) => x.id === e.target.value);
                  setForm({
                    ...form,
                    defaultModel: m ? { provider: String((m as { provider?: unknown }).provider ?? ""), id: m.id } : null,
                  });
                }}
              >
                <option value="">Default (agent decides)</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.label || m.id}</option>
                ))}
                {form.defaultModel && !models.some((m) => m.id === form.defaultModel!.id) && (
                  <option value={form.defaultModel.id}>{form.defaultModel.id}</option>
                )}
              </select>
            ) : (
              <p className="muted">This agent selects its own model — nothing to set.</p>
            )}

            <label className="field-label">Default sandbox mode</label>
            <div className="seg-row">
              {SANDBOX_TIERS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`seg-btn${form.defaultSandbox === t.id ? " active" : ""}`}
                  onClick={() => setForm({ ...form, defaultSandbox: t.id })}
                  title={t.hint}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p className="muted small">{SANDBOX_TIERS.find((t) => t.id === form.defaultSandbox)?.hint}</p>
          </section>

          <section className="settings-section">
            <h4 className="settings-subhead">GitHub</h4>
            <label className="field-label">GitHub session limit</label>
            <input
              className="picker-search"
              type="number"
              min={0}
              value={form.githubMaxConcurrent}
              onChange={(e) => setForm({ ...form, githubMaxConcurrent: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
            />
            <p className="muted small">Max GitHub-triggered sessions this node runs at once; the rest queue until a slot frees. 0 = unlimited.</p>

            <label className="field-label">GitHub issue prompt</label>
            <textarea
              className="picker-search"
              rows={8}
              value={form.githubIssuePrompt}
              onChange={(e) => setForm({ ...form, githubIssuePrompt: e.target.value })}
            />
            <p className="muted small">
              The instructions sent to the agent as its first message when it picks up a GitHub issue (after the issue's own
              title/description/link). The default asks it to understand the issue, do thorough work, run tests/linter/type-checks,
              and open its own pull request when done — edit freely, or clear and save to restore the default.
            </p>
            <div className="row-actions">
              <button className="btn" onClick={resetIssuePrompt}>Reset to default</button>
            </div>
          </section>

          <section className="settings-section">
            <h4 className="settings-subhead">Session sync</h4>
            <div className="settings-toggle-row">
              <div className="settings-toggle-text">
                <span className="settings-toggle-title">Keep sessions synced to a standby node</span>
                <span className="muted small">
                  Warm-replicate each session's transcript to another of your nodes over the encrypted
                  relay, so a session can be picked up elsewhere if this node goes offline. Data stays
                  node-to-node; the control plane never sees it.
                </span>
              </div>
              <Toggle
                checked={form.sessionSync}
                onChange={(v) => setForm({ ...form, sessionSync: v, worktreeSync: v ? form.worktreeSync : false })}
                label="Enable session sync"
              />
            </div>
            <div className={`settings-toggle-row${form.sessionSync ? "" : " disabled"}`}>
              <div className="settings-toggle-text">
                <span className="settings-toggle-title">Also sync the workspace (git checkpoints)</span>
                <span className="muted small">
                  Ship each turn's git checkpoint too, so the promoted session keeps its working tree and
                  can continue coding — not just show history. Needs session sync; ignored for non-git workspaces.
                </span>
              </div>
              <Toggle
                checked={form.worktreeSync}
                disabled={!form.sessionSync}
                onChange={(v) => setForm({ ...form, worktreeSync: v })}
                label="Enable worktree sync"
              />
            </div>
            {form.sessionSync && (
              <>
                <label className="field-label">Standby node</label>
                <select
                  className="picker-search"
                  value={form.syncStandbyNodeId ?? ""}
                  onChange={(e) => setForm({ ...form, syncStandbyNodeId: e.target.value || undefined })}
                >
                  <option value="">Choose a node to replicate to…</option>
                  {nodes
                    .filter((n) => n.id !== currentNodeId)
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {(n.name || n.id) + (n.online ? "" : " (offline)")}
                      </option>
                    ))}
                  {form.syncStandbyNodeId && !nodes.some((n) => n.id === form.syncStandbyNodeId) && (
                    <option value={form.syncStandbyNodeId}>{form.syncStandbyNodeId}</option>
                  )}
                </select>
                <p className="muted small">
                  Sessions on this node warm-replicate to the standby over the encrypted relay. If this
                  node goes offline, open the session on the standby and choose “Continue here”.
                  {nodes.filter((n) => n.id !== currentNodeId).length === 0 && " Add a second node to enable this."}
                </p>
              </>
            )}
          </section>

          <div className="row-actions">
            <button className="btn primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
            {savedMsg && <span className="chip ok">{savedMsg}</span>}
            {saveErr && <span className="chip err">{saveErr}</span>}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Ephemeral machines (per-provider setup + launch preferences) ----
// The new-session flow (the header "Ephemeral machine…" sheet) still owns
// launching; this panel is the persistent home for *configuring* each cloud
// provider — saving its token and the default region/size/TTL/repo the launch
// flow pre-fills from. Additive: it reuses the same device-local stores and
// leaves the launch sheet untouched.
const EPHEMERAL_TTL_OPTIONS = [
  { v: 30, label: "30 min" },
  { v: 60, label: "1 hour" },
  { v: 180, label: "3 hours" },
  { v: 480, label: "8 hours" },
];

function EphemeralPanel() {
  const [keys, setKeys] = useState<ProviderKeyInfo[]>([]);
  const [provider, setProvider] = useState<string | null>(null);
  const refreshKeys = () => controller.listEphemeralKeys().then(setKeys).catch(() => {});
  useEffect(() => { refreshKeys(); }, []);

  const catalog = EPHEMERAL_PROVIDERS.find((p) => p.id === provider);
  if (catalog) {
    return (
      <div className="settings-form">
        <button className="link-btn" onClick={() => setProvider(null)}>‹ All providers</button>
        <h3>{catalog.name}</h3>
        <EphemeralProviderConfig providerId={catalog.id} onKeysChanged={refreshKeys} />
      </div>
    );
  }

  return (
    <div className="settings-form">
      <p className="muted settings-intro">
        Bring your own cloud token to spin up temporary nodes that self-destruct at their TTL. Configure each provider
        here — its token and the default region, size, and auto-destroy time — and the new-session “Ephemeral machine”
        launcher pre-fills them.
      </p>
      <div className="picker-list">
        {EPHEMERAL_PROVIDERS.map((p) => {
          const k = keys.find((x) => x.id === p.id);
          return (
            <PickerItem
              key={p.id}
              title={p.name}
              meta={p.blurb}
              right={k?.configured ? <span className="chip ok">Token saved</span> : <span className="chip">Not set up</span>}
              onClick={() => setProvider(p.id)}
            />
          );
        })}
      </div>
      <EphemeralModelKeys />
    </div>
  );
}

// Model API keys held on THIS device to seed a freshly-launched machine's vault
// over its encrypted channel — so a brand-new runner has model credentials even
// when it's the account's only node and there's no peer to sync the model-auth
// vault from (the cold-start gap; see docs/ephemeral-sessions.md). API keys
// only; agent subscription/OAuth logins can't be replayed onto disposable
// machines. Same device-local privacy model as the cloud provider tokens above.
const COMMON_MODEL_PROVIDERS = [
  "anthropic", "openai", "google", "groq", "mistral",
  "openrouter", "deepseek", "xai", "together", "fireworks", "cohere",
];

function EphemeralModelKeys() {
  const [keys, setKeys] = useState<EphemeralModelKeyInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => controller.listEphemeralModelKeys().then(setKeys).catch(() => {});
  useEffect(() => { refresh(); }, []);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await controller.setEphemeralModelKey(provider, key);
      setProvider("");
      setKey("");
      setMsg("Saved on this device.");
      refresh();
    } catch (e) {
      setMsg(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h4 className="settings-subhead">Model keys for new machines</h4>
      <p className="muted small">
        API keys kept on this device and pushed into a freshly-launched machine over its encrypted channel, so a
        brand-new runner has model credentials even when it's your only node. Never sent to our servers or baked into
        the machine image. API keys only — agent subscription logins can't be seeded this way.
      </p>
      {keys.length > 0 && (
        <div className="picker-list">
          {keys.map((k) => (
            <PickerItem
              key={k.provider}
              title={k.provider}
              meta={k.configured ? "Key saved on this device" : "Not set"}
              right={
                <button
                  type="button"
                  className="picker-action danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    controller.removeEphemeralModelKey(k.provider).then(refresh);
                  }}
                >
                  Remove
                </button>
              }
            />
          ))}
        </div>
      )}
      <datalist id="eph-model-providers">
        {COMMON_MODEL_PROVIDERS.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <label className="field-label">Provider</label>
      <input
        className="picker-search"
        list="eph-model-providers"
        value={provider}
        placeholder="e.g. anthropic"
        onChange={(e) => setProvider(e.target.value)}
      />
      <label className="field-label">API key</label>
      <input
        className="picker-search"
        type="password"
        value={key}
        placeholder="Paste key"
        onChange={(e) => setKey(e.target.value)}
      />
      <button className="btn primary" disabled={busy || !provider.trim() || !key.trim()} onClick={save}>
        {busy ? "Saving…" : "Save key"}
      </button>
      {msg && <p className="muted">{msg}</p>}
    </section>
  );
}

function EphemeralProviderConfig({ providerId, onKeysChanged }: { providerId: string; onKeysChanged: () => void }) {
  const catalog = EPHEMERAL_PROVIDERS.find((p) => p.id === providerId)!;
  const adapter = ephemeralAdapter(providerId)!;
  const [confirm, setConfirm] = useState<null | { title: string; message: string; label?: string; action: () => void }>(null);
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [region, setRegion] = useState(adapter.defaultRegion);
  const [sizes, setSizes] = useState<ProviderSize[]>(adapter.sizes);
  const [size, setSize] = useState(adapter.defaultSize);
  const [ttl, setTtl] = useState(60);
  const [repo, setRepo] = useState("");
  const [machines, setMachines] = useState<EphemeralMachine[]>([]);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Both saveToken and savePrefs are already real awaited requests — the
  // missing piece was an in-flight guard against a double-submit (#140).
  const [busy, setBusy] = useState(false);

  const refreshMachines = () =>
    controller.listEphemeralMachines().then((all) => setMachines(all.filter((m) => m.provider === providerId))).catch(() => {});

  // Seed the form from the saved token + preferences for this provider.
  useEffect(() => {
    controller.getEphemeralToken(providerId).then((t) => setHasToken(Boolean(t))).catch(() => {});
    controller.getEphemeralPrefs(providerId).then((p: EphemeralPrefs) => {
      if (p.region) setRegion(p.region);
      if (p.size) setSize(p.size);
      if (typeof p.ttlMinutes === "number") setTtl(p.ttlMinutes);
      if (p.repo) setRepo(p.repo);
    }).catch(() => {});
    refreshMachines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  // Once a token is saved, swap the static catalog for the provider's live,
  // non-deprecated sizes for the chosen region (mirrors the launch sheet).
  useEffect(() => {
    if (!hasToken) return;
    let active = true;
    controller.listEphemeralSizes(providerId, region).then((list) => {
      if (!active || !list.length) return;
      setSizes(list);
      setSize((cur) => (list.some((s) => s.id === cur) ? cur : list.some((s) => s.id === adapter.defaultSize) ? adapter.defaultSize : (list[0]?.id ?? adapter.defaultSize)));
    }).catch(() => {});
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken, providerId, region]);

  const saveToken = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await controller.setEphemeralToken(providerId, token.trim());
      setToken("");
      setHasToken(true);
      onKeysChanged();
      setMsg("Token saved on this device.");
    } catch (e) {
      setMsg(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  const savePrefs = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await controller.setEphemeralPrefs(providerId, { region, size, ttlMinutes: ttl, repo: repo.trim() || null });
      setSavedMsg("Saved");
      setTimeout(() => setSavedMsg(null), 1500);
    } catch (e) {
      setMsg(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-form">
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.label || "Remove"}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => { confirm.action(); setConfirm(null); }}
        />
      )}
      {!hasToken ? (
        <>
          <p className="muted">{catalog.blurb}</p>
          <ol className="eph-steps">
            {catalog.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          <div className="row-actions">
            {catalog.links.map((l) => (
              <a key={l.url} className="btn ghost" href={l.url} target="_blank" rel="noopener">{l.label}</a>
            ))}
          </div>
          <label className="field-label">{catalog.tokenLabel}</label>
          <input className="picker-search" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste token" />
          <button className="btn primary" disabled={!token.trim() || busy} onClick={saveToken}>{busy ? "Saving…" : "Save token"}</button>
        </>
      ) : (
        <>
          <p className="muted">
            Token saved on this device. Set the defaults new machines launch with — you can still change them per launch.
          </p>
          <label className="field-label">Region</label>
          <select className="picker-search" value={region} onChange={(e) => setRegion(e.target.value)}>
            {adapter.regions.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>

          <label className="field-label">Server type</label>
          <select className="picker-search" value={size} onChange={(e) => setSize(e.target.value)}>
            {sizes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>

          <label className="field-label">Auto-destroy after</label>
          <select className="picker-search" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
            {EPHEMERAL_TTL_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>

          <label className="field-label">Repo (optional, owner/name)</label>
          <input className="picker-search" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" />

          <div className="row-actions">
            <button className="btn primary" disabled={busy} onClick={savePrefs}>{busy ? "Saving…" : "Save preferences"}</button>
            {savedMsg && <span className="chip ok">{savedMsg}</span>}
            <button
              className="btn danger-ghost"
              onClick={() => setConfirm({
                title: "Remove provider token?",
                message: `Forget the ${catalog.name} token on this device?`,
                action: () => controller.removeEphemeralToken(providerId).then(() => {
                  setHasToken(false);
                  onKeysChanged();
                }),
              })}
            >
              Remove token
            </button>
          </div>
        </>
      )}
      {msg && <p className="muted">{msg}</p>}
      {machines.length > 0 && (
        <>
          <label className="field-label">Running machines</label>
          <div className="picker-list">
            {machines.map((m) => (
              <PickerItem
                key={m.id}
                title={m.name || m.id}
                meta={[m.region, m.ip, m.repo, m.status].filter(Boolean).join(" · ")}
                right={
                  <button
                    type="button"
                    className="picker-action danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirm({
                        title: "Destroy machine?",
                        message: `Destroy ${m.name || m.id} now? This can't be undone.`,
                        label: "Destroy",
                        action: () => controller.destroyEphemeral(m).then(refreshMachines),
                      });
                    }}
                  >
                    Destroy
                  </button>
                }
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Account / billing ----
function AccountPanel() {
  const [me, setMe] = useState<AccountMe | null>(null);
  const [nodes, setNodes] = useState<Awaited<ReturnType<typeof controller.listNodes>>>([]);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; label?: string; action: () => void }>(null);
  const reloadMe = () => controller.fetchMe().then(setMe).catch(() => {});
  const reloadDevices = () => controller.listDevices().then(setDevices).catch(() => {});
  useEffect(() => {
    controller.fetchMe().then(setMe).catch((e) => setErr(String(e.message || e)));
    controller.listNodes().then(setNodes).catch(() => {});
    reloadDevices();
  }, []);
  const ent = me?.entitlements;
  const counts = me?.counts;
  const free = (ent?.plan || me?.account?.plan) === "free";
  // Free's one cap: runs per rolling 7-day window across every source. Undefined = unlimited (paid).
  const runCap = ent ? (ent.weeklyRunLimit ?? "∞") : "—";
  return (
    <div className="settings-form">
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.label || "Remove"}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => { confirm.action(); setConfirm(null); }}
        />
      )}
      {err && <div className="banner error inline">{err}</div>}
      <div className="stat-grid">
        <Stat label="Plan" value={planLabel(ent?.plan || me?.account?.plan)} />
        <Stat label="Runs / week" value={`${counts?.runsThisWeek ?? "—"} / ${runCap}`} />
      </div>
      {free && (
        <p className="muted settings-intro">
          You're on the free plan — everything's included, capped at {runCap} runs per rolling 7 days across
          every source (manual, app, GitHub queue, ephemeral). Pro removes the cap for {PRO_PRICE_LABEL}.
        </p>
      )}
      <div className="row-actions">
        {free ? (
          <button
            className="btn primary"
            disabled={opening}
            onClick={() => {
              setOpening(true);
              setErr(null);
              // Both buttons fetch a redirect URL before navigating away — with
              // no busy state the button just looked dead in that gap (#140).
              // `finally` only fires on a failure to redirect; success replaces
              // this page before it can run.
              controller.startCheckout().catch((e) => setErr(String(e.message || e))).finally(() => setOpening(false));
            }}
          >
            {opening ? "Opening…" : `Upgrade to Pro — ${PRO_PRICE_LABEL}`}
          </button>
        ) : (
          <button
            className="btn"
            disabled={opening}
            onClick={() => {
              setOpening(true);
              setErr(null);
              controller.openBillingPortal().catch((e) => setErr(String(e.message || e))).finally(() => setOpening(false));
            }}
          >
            {opening ? "Opening…" : "Manage billing"}
          </button>
        )}
      </div>
      <label className="field-label">Enrolled nodes</label>
      <div className="picker-list">
        {nodes.map((n) => (
          <PickerItem
            key={n.id}
            active={n.id === controller.local.cur}
            title={n.name || n.id}
            meta={n.online ? "Online" : "Offline"}
            right={
              <button
                type="button"
                className="picker-action danger"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirm({
                    title: "Remove node?",
                    message: `Remove ${n.name || n.id} from your account?`,
                    action: () => controller.removeNode(n.id).then(() => controller.listNodes().then(setNodes)),
                  });
                }}
              >
                Remove
              </button>
            }
            onClick={() => controller.switchNode(n.id)}
          />
        ))}
      </div>
      <label className="field-label">Signed-in devices</label>
      <div className="picker-list">
        {devices.length === 0 && <p className="muted">No paired devices.</p>}
        {devices.map((d) => {
          const current = controller.isCurrentDevice(d.id);
          return (
            <PickerItem
              key={d.id}
              title={`${d.label || "Device"}${current ? " (this device)" : ""}`}
              meta={`Last active ${formatDeviceDate(d.updatedAt)}`}
              right={
                <button
                  type="button"
                  className="picker-action danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirm({
                      title: current ? "Sign out this device?" : "Sign out device?",
                      message: current ? "This device will need to sign in again." : `Sign out ${d.label || "this device"}?`,
                      label: "Sign out",
                      action: () => controller
                        .removeDevice(d.id)
                        .then(() => {
                          reloadDevices();
                          reloadMe();
                        })
                        .catch((err) => setErr(String(err.message || err))),
                    });
                  }}
                >
                  Sign out
                </button>
              }
            />
          );
        })}
      </div>
      {/* This signs the whole account out on this device (unlike the
          per-device "Sign out" above, which only revokes one paired device) —
          the higher-impact action, so it gets the same confirmation every
          other destructive action in this panel already has. */}
      <button
        className="btn danger-ghost block"
        onClick={() => setConfirm({
          title: "Sign out?",
          message: "Sign out of Bivy on this device?",
          label: "Sign out",
          action: () => controller.signOut(),
        })}
      >
        Sign out
      </button>
    </div>
  );
}

function formatDeviceDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "recently";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

// ---- Link a device ----
function LinkPanel({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="settings-form">
      <p className="muted">Paste a device-link URL or code from another Bivy client to add its node here.</p>
      <textarea
        className="picker-search"
        rows={4}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // Clear the stale error as soon as the user edits — otherwise a
          // failed link keeps showing "didn't look like a valid device link"
          // through a correction and retry, until the next success (#140).
          setErr(null);
        }}
        placeholder="https://…#… or code"
      />
      <button
        className="btn primary"
        disabled={!text.trim()}
        onClick={() => {
          if (controller.applyLinkPayload(text.trim())) onDone();
          else setErr("That didn't look like a valid device link.");
        }}
      >
        Link
      </button>
      {err && <div className="banner error inline">{err}</div>}
    </div>
  );
}
