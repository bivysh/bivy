// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AccountMe, AccountNode, AppState, AutomationHook, AutomationOutcome, EphemeralNodeConfig, QueueRouting, HostedProvisioningStatus, HostedAuditEvent, LocalModelPreset, LocalModelProvider, PairedDevice, GithubAppEntry, GithubAppInfo, GithubQueueItem, NodeSettings, NotificationPreferences, SandboxTier, SlackHook, LinearHook, EphemeralMachine, EphemeralModelKeyInfo, ProviderKeyInfo, ProviderSize } from "@bivy/core";
import { NOTIFICATION_KIND_META, EPHEMERAL_PROVIDERS, ephemeralAdapter, ephemeralCostHint, connectSlackHook, disconnectSlackHook, fetchSlackHook, connectLinearHook, disconnectLinearHook, fetchLinearHook, createAutomationHook, fetchAutomationHooks, revokeAutomationHook, rotateAutomationHookSecret, updateAutomationHook } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { PickerItem } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { OauthStep } from "./ProviderConnect.js";
import { GithubQueuePanel } from "./GithubQueue.js";
import { RulesetsPanel } from "./Rulesets.js";
import { ImportSessionContent } from "./ImportSessionSheet.js";
import { currentThemeSetting, setTheme, type ThemeSetting } from "../theme.js";
import { useModalEscape } from "../modalStack.js";
import type { SettingsView } from "../router.js";
import { EPHEMERAL_MACHINES_ENABLED } from "../flags.js";
import { SourceGlyph } from "./SourceMark.js";

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
// Reuse the official brand geometry used by run-source marks instead of
// maintaining approximate line-art versions in Settings.
const IconSlack = () => <SourceGlyph kind="slack" />;
const IconLinear = () => <SourceGlyph kind="linear" />;
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
// Webhook glyph — three linked nodes, the conventional inbound-hook mark.
const IconWebhook = () => (
  <Glyph><circle cx="6" cy="16" r="2.5" /><circle cx="18" cy="16" r="2.5" /><circle cx="12" cy="5" r="2.5" /><path d="m10.7 7.1-3 5.2M13.3 7.1l3 5.2M8.5 16h7" /></Glyph>
);
// Branch/policy glyph for Rulesets — a decision splitting into fallback routes.
const IconRules = () => (
  <Glyph><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="12" r="2" /><path d="M8 6h4a4 4 0 0 1 4 4M8 18h4a4 4 0 0 0 4-4" /></Glyph>
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
// Same download-into-tray glyph the sidebar header used to carry, so the
// relocated action stays visually recognisable in its new Settings home.
const IconImport = () => (
  <Glyph><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 19h14" /></Glyph>
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

/** Render the baked-in PWA build timestamp (see __APP_BUILD_TIME__) as a short
 *  local date+time, or "" when it isn't a parseable ISO string. */
function formatBuildTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
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
  import: "Import session",
  providers: "Keys & OAuth",
  models: "Local models",
  voice: "Voice input",
  github: "GitHub App",
  linear: "Linear",
  slack: "Slack",
  queue: "Work Queue",
  webhooks: "Webhooks",
  rulesets: "Rulesets",
  nodes: "Nodes",
  ephemeral: "Ephemeral machines",
  account: "Account & billing",
  link: "Link a device",
};

// Search the concepts and controls inside each panel, not just its title. This
// remains intentionally compact: selecting a result opens the owning panel.
const SEARCH_TERMS: Record<View, string> = {
  appearance: "theme system light dark",
  notifications: "push alerts attention approval permission idle completed",
  import: "session transcript file upload migrate",
  providers: "api key oauth openai anthropic google login credentials",
  models: "ollama local model endpoint",
  voice: "microphone speech transcription",
  github: "github app repository installation issue pull request",
  linear: "linear workspace issue integration",
  slack: "slack workspace channel integration",
  queue: "work queue issue run evidence outcome retry lease checks",
  webhooks: "webhook trigger secret event",
  rulesets: "rules policy routing agent runtime model sandbox",
  nodes: "node daemon online offline diagnostics version update storage disk",
  ephemeral: "ephemeral hosted machine provisioning billing teardown retention",
  account: "account billing subscription plan usage",
  link: "device qr code phone mobile pair",
};

export function Settings({
  state,
  onClose,
  view,
  onViewChange,
  githubQueue,
  onRefreshGithubQueue,
  onPickSession,
  onImported,
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
  /** Fired when the Import-session panel adopts a session — the controller has
   *  already opened/navigated to it, so the caller just dismisses Settings. */
  onImported?: (sessionId: string) => void;
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
      label: "Models & agents",
      items: [
        { id: "providers", label: "Keys & OAuth", icon: <IconKey /> },
        { id: "models", label: "Local models", icon: <IconCpu /> },
      ],
    },
    {
      label: "Machines",
      items: [
        { id: "nodes", label: "Nodes", icon: <IconServer /> },
        ...(EPHEMERAL_MACHINES_ENABLED
          ? [{ id: "ephemeral" as View, label: "Ephemeral machines", icon: <IconBolt /> }]
          : []),
      ],
    },
    {
      label: "Integrations",
      items: [
        { id: "github", label: "GitHub App", icon: <IconGithub /> },
        ...(hosted ? [
          { id: "linear" as View, label: "Linear", icon: <IconLinear /> },
          { id: "slack" as View, label: "Slack", icon: <IconSlack /> },
        ] : []),
      ],
    },
    {
      label: "Automation & policy",
      items: [
        { id: "queue", label: "Work Queue", icon: <IconQueue /> },
        { id: "webhooks", label: "Webhooks", icon: <IconWebhook /> },
        { id: "rulesets", label: "Rulesets", icon: <IconRules /> },
      ],
    },
    {
      label: "App",
      items: [
        { id: "appearance", label: "Appearance", icon: <IconAppearance /> },
        { id: "notifications", label: "Notifications", icon: <IconBell /> },
        { id: "voice", label: "Voice input", icon: <IconMic /> },
        { id: "import", label: "Import session", icon: <IconImport /> },
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
  const matches = (item: NavItem) => !q || `${item.label} ${SEARCH_TERMS[item.id]}`.toLowerCase().includes(q);
  // A query matching nothing used to hide every group and leave the sidebar
  // blank — looked broken rather than "no results" (#140).
  const hasVisibleNavItem = groups.some((group) => group.items.some(matches));

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
              const visible = group.items.filter(matches);
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
          <div className="settings-nav-version" title="The version of the Bivy app running on this device">
            <span>Bivy v{__APP_VERSION__}</span>
            {formatBuildTime(__APP_BUILD_TIME__) && (
              <span className="settings-nav-version-updated">Updated {formatBuildTime(__APP_BUILD_TIME__)}</span>
            )}
          </div>
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
            {activeView === "import" && <ImportPanel onImported={(id) => onImported?.(id)} />}
            {activeView === "providers" && <ProvidersPanel state={state} />}
            {activeView === "models" && <LocalModelsPanel state={state} />}
            {activeView === "voice" && <VoicePanel state={state} />}
            {activeView === "github" && <GithubPanel state={state} onOpenGithubQueue={() => onViewChange("queue")} />}
            {activeView === "linear" && <LinearPanel />}
            {activeView === "slack" && <SlackPanel />}
            {activeView === "queue" && (
              <GithubQueuePanel
                queue={githubQueue ?? null}
                onRefresh={() => onRefreshGithubQueue?.()}
                onPick={(id, path, nodeId) => onPickSession?.(id, path, nodeId)}
                onOpenGithubSettings={() => onViewChange("github")}
              />
            )}
            {activeView === "webhooks" && <WebhookTriggersPanel />}
            {activeView === "rulesets" && <RulesetsPanel state={state} />}
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

// ---- Import session (relocated from the sidebar header) ----
function ImportPanel({ onImported }: { onImported: (sessionId: string) => void }) {
  return (
    <div className="settings-form">
      <p className="muted">
        Adopt a Claude Code or Codex session that was started outside Bivy. Only
        sessions this node (or another one you pick) can see and safely take over
        are listed.
      </p>
      <ImportSessionContent onDone={onImported} />
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

// Node-label selector shared by the GitHub App "Default node" field and the
// generic Automations webhook routing default (issue #166): a dropdown of the
// account's known nodes, exactly like the GitHub issues flow, so a routing
// default is picked rather than typed blind. Only falls back to free text when
// the account has no known nodes yet (nothing to pick from).
function NodeRouteSelect({
  nodes,
  value,
  onChange,
  disabled,
}: {
  nodes: AccountNode[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  if (nodes.length === 0) {
    return (
      <input
        className="picker-search"
        value={value}
        placeholder="node label, e.g. macbook"
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <select className="picker-search" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">Shared queue (any online node)</option>
      {nodes.map((n) => (
        <option key={n.id} value={n.name || n.id}>{n.name || n.id}</option>
      ))}
      {value && !nodes.some((n) => (n.name || n.id) === value) && <option value={value}>{value}</option>}
    </select>
  );
}

// Account-level "auto-provision an ephemeral server when nothing's online"
// preference (issue #532), self-contained so both the GitHub App panel and the
// generic Automations panel can offer it (issue #166) without each keeping a
// separate copy of the fetch/save plumbing — it's one account setting either
// way, and (per the trigger-neutral automation-run queue) already covers
// webhook-triggered runs alongside GitHub ones once enabled.
type EphemeralConfigDraft = {
  editing?: string;
  name: string;
  provider: string;
  region: string;
  size: string;
  ttlMinutes: number | null;
  teardownOnAgentFinish: boolean;
};

const QUEUE_TTL_OPTIONS = [
  { v: 30, label: "30 min" },
  { v: 60, label: "1 hour" },
  { v: 180, label: "3 hours" },
];

// Account-level queue routing (issue #532 / ephemeral configs). Picks the
// default runner for queued work — the shared queue, a persistent node, or an
// ephemeral config (a reusable, named runner template shown "as a node"). A
// persistent-node primary may carry an ephemeral-config fallback for when the
// node is offline; an ephemeral-config primary needs none (it's provisioned on
// demand). Also manages the account's ephemeral configs (create/edit/remove).
function QueueRoutingSection() {
  const [nodes, setNodes] = useState<AccountNode[]>([]);
  const [configs, setConfigs] = useState<EphemeralNodeConfig[]>([]);
  const [routing, setRouting] = useState<QueueRouting | null>(null);
  const [keys, setKeys] = useState<ProviderKeyInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<EphemeralConfigDraft | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<EphemeralNodeConfig | null>(null);

  const refreshConfigs = () => controller.listEphemeralConfigs().then(setConfigs).catch(() => {});
  useEffect(() => {
    controller.listNodes().then(setNodes).catch(() => {});
    controller.listEphemeralKeys().then(setKeys).catch(() => {});
    controller.getQueueRouting().then(setRouting).catch(() => setRouting(null));
    refreshConfigs();
  }, []);

  const persistentNodes = nodes.filter((n) => !n.id.startsWith("eph-"));
  const primaryValue = routing?.primary.kind === "node" ? `node:${routing.primary.node}`
    : routing?.primary.kind === "config" ? `config:${routing.primary.configId}` : "shared";
  const fallbackValue = routing?.fallback?.kind === "config" ? `config:${routing.fallback.configId}` : "";
  const primaryIsNode = routing?.primary.kind === "node";
  const providerName = (id: string) => keys.find((k) => k.id === id)?.name || id;
  const providerReady = (id: string) => Boolean(keys.find((k) => k.id === id)?.configured);

  const saveRouting = async (primaryStr: string, fallbackStr: string) => {
    setErr(null);
    setBusy(true);
    try {
      const primary: QueueRouting["primary"] = primaryStr.startsWith("node:")
        ? { kind: "node", node: primaryStr.slice("node:".length) }
        : primaryStr.startsWith("config:")
          ? { kind: "config", configId: primaryStr.slice("config:".length) }
          : { kind: "shared" };
      const next: QueueRouting = primary.kind === "node" && fallbackStr.startsWith("config:")
        ? { primary, fallback: { kind: "config", configId: fallbackStr.slice("config:".length) } }
        : { primary };
      setRouting(await controller.setQueueRouting(next));
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const saveConfig = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) { setErr("Config name is required"); return; }
    if (!draft.provider) { setErr("Choose a provider"); return; }
    setErr(null);
    setBusy(true);
    try {
      const input = {
        name, provider: draft.provider,
        region: draft.region.trim() || null,
        size: draft.size.trim() || null,
        ttlMinutes: draft.ttlMinutes ?? null,
        teardownOnAgentFinish: draft.teardownOnAgentFinish,
      };
      if (draft.editing) await controller.updateEphemeralConfig(draft.editing, input);
      else await controller.createEphemeralConfig(input);
      setDraft(null);
      refreshConfigs();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const removeConfig = async (cfg: EphemeralNodeConfig) => {
    setConfirmRemove(null);
    setBusy(true);
    try {
      await controller.removeEphemeralConfig(cfg.id);
      refreshConfigs();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label className="field-label"><span>Primary runner</span>
        <select className="picker-search" value={primaryValue} disabled={busy} onChange={(e) => saveRouting(e.target.value, fallbackValue)}>
          <option value="shared">Shared queue (any online node)</option>
          {persistentNodes.length > 0 && (
            <optgroup label="Persistent nodes">
              {persistentNodes.map((n) => (
                <option key={n.id} value={`node:${n.name || n.id}`}>{n.name || n.id}</option>
              ))}
            </optgroup>
          )}
          {configs.length > 0 && (
            <optgroup label="Ephemeral configs">
              {configs.map((c) => (
                <option key={c.id} value={`config:${c.id}`}>{c.name} · {c.provider}</option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {primaryIsNode && (
        <label className="field-label"><span>Fallback if node is offline</span>
          <select className="picker-search" value={fallbackValue} disabled={busy} onChange={(e) => saveRouting(primaryValue, e.target.value)}>
            <option value="">None — wait for the node</option>
            {configs.map((c) => (
              <option key={c.id} value={`config:${c.id}`}>{c.name} · {c.provider}</option>
            ))}
          </select>
        </label>
      )}
      <p className="muted small">
        {primaryIsNode
          ? "Queued work waits for this node; if it's offline and a fallback is set, that ephemeral config is provisioned instead."
          : routing?.primary.kind === "config"
            ? "Queued work provisions a fresh machine from this config when nothing persistent is online."
            : "Queued work is picked up by any online node."}
      </p>

      <h4 className="settings-subhead">Ephemeral configs</h4>
      {draft ? (
        <div className="settings-form">
          <label className="field-label"><span>Name</span>
            <input className="picker-search" value={draft.name} placeholder="e.g. fly-small-iad" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="field-label"><span>Provider</span>
            <select className="picker-search" value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value })}>
              <option value="" disabled>Choose a provider</option>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>{k.name}{k.configured ? "" : " (no token on this device)"}</option>
              ))}
            </select>
          </label>
          <label className="field-label"><span>Region (optional)</span>
            <input className="picker-search" value={draft.region} placeholder="provider default" onChange={(e) => setDraft({ ...draft, region: e.target.value })} />
          </label>
          <label className="field-label"><span>Server type (optional)</span>
            <input className="picker-search" value={draft.size} placeholder="provider default" onChange={(e) => setDraft({ ...draft, size: e.target.value })} />
          </label>
          <label className="field-label"><span>Auto-destroy after</span>
            <select className="picker-search" value={draft.ttlMinutes ?? ""} onChange={(e) => setDraft({ ...draft, ttlMinutes: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Provider default</option>
              {QUEUE_TTL_OPTIONS.map((o) => (<option key={o.v} value={o.v}>{o.label}</option>))}
            </select>
          </label>
          <div className="settings-toggle-row">
            <div className="settings-toggle-text">
              <span className="settings-toggle-title">Destroy after the agent finishes</span>
              <span className="muted small">Tear the machine down on agent_end; the TTL stays a safety fallback.</span>
            </div>
            <Toggle checked={draft.teardownOnAgentFinish} onChange={(v) => setDraft({ ...draft, teardownOnAgentFinish: v })} label="Destroy after the agent finishes" />
          </div>
          <div className="row-actions">
            <button className="btn primary" disabled={busy || !draft.name.trim() || !draft.provider} onClick={saveConfig}>
              {busy ? "Saving…" : draft.editing ? "Save changes" : "Add config"}
            </button>
            <button className="btn" onClick={() => { setErr(null); setDraft(null); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div className="picker-list">
            {configs.length === 0 && <div className="picker-empty">No ephemeral configs yet.</div>}
            {configs.map((c) => (
              <PickerItem
                key={c.id}
                title={c.name}
                meta={`${providerName(c.provider)}${c.region ? " · " + c.region : ""}${c.size ? " · " + c.size : ""}${c.ttlMinutes ? " · " + c.ttlMinutes + "m" : ""}${providerReady(c.provider) ? "" : " · no token here"}`}
                right={<button className="btn danger-ghost sm" onClick={(e) => { e.stopPropagation(); setConfirmRemove(c); }}>Remove</button>}
                onClick={() => { setErr(null); setDraft({ editing: c.id, name: c.name, provider: c.provider, region: c.region ?? "", size: c.size ?? "", ttlMinutes: c.ttlMinutes ?? null, teardownOnAgentFinish: Boolean(c.teardownOnAgentFinish) }); }}
              />
            ))}
          </div>
          <button className="btn primary block" onClick={() => { setErr(null); setDraft({ name: "", provider: keys[0]?.id ?? "", region: "", size: "", ttlMinutes: null, teardownOnAgentFinish: false }); }}>+ Add config</button>
        </>
      )}
      {err && <span className="chip err">{err}</span>}
      {confirmRemove && (
        <ConfirmDialog
          title="Remove config?"
          message={`Remove ${confirmRemove.name}? Queued work routed to it will fall back to the shared queue.`}
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => removeConfig(confirmRemove)}
        />
      )}
    </>
  );
}

const HOSTED_PROVIDERS = [
  { id: "fly", name: "Fly.io" },
  { id: "hetzner", name: "Hetzner" },
  { id: "aws", name: "AWS" },
];

// Unattended (control-plane-orchestrated) provisioning. Lets the control plane
// launch an ephemeral config when work arrives with no device online. This
// stores cloud + GitHub credentials on the control plane — see
// docs/hosted-provisioning-trust-model.md — so it's opt-in and surfaces the
// trust trade-off, the encryption-key status, and an audit trail here.
function HostedProvisioningSection() {
  const [status, setStatus] = useState<HostedProvisioningStatus | null>(null);
  const [audit, setAudit] = useState<HostedAuditEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [mode, setMode] = useState<"app" | "pat">("app");
  const [appId, setAppId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [pat, setPat] = useState("");
  const [provider, setProvider] = useState("fly");
  const [providerToken, setProviderToken] = useState("");
  const [confirmEnable, setConfirmEnable] = useState(false);

  const refreshAudit = () => controller.listHostedAudit().then(setAudit).catch(() => {});
  useEffect(() => {
    controller.getHostedProvisioning().then(setStatus).catch(() => setStatus(null));
    refreshAudit();
  }, []);

  const save = async (patch: Parameters<typeof controller.setHostedProvisioning>[0], done?: () => void) => {
    setErr(null);
    setBusy(true);
    try {
      setStatus(await controller.setHostedProvisioning(patch));
      done?.();
      refreshAudit();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setErr(null);
    setTestMsg(null);
    try {
      const { plan } = await controller.triggerHostedProvision(false);
      setTestMsg(plan.willProvision ? `Ready — would provision ${plan.targetConfigId}` : `Would not provision: ${plan.reason}`);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    }
  };

  const rotate = async () => {
    setErr(null);
    setBusy(true);
    try {
      setStatus(await controller.rotateHostedProvisioning());
      refreshAudit();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const enabled = Boolean(status?.enabled);
  const canSaveSecrets = Boolean(status?.encryptionReady);

  return (
    <>
      <p className="muted small">
        Let the control plane launch an ephemeral config for queued work when nothing is online — no device needed.
        This stores cloud and GitHub credentials on the control plane (encrypted at rest); it is opt-in per account.
      </p>

      {status && !status.encryptionReady && (
        <div className="banner error inline">
          Credential encryption is not configured on the server (<code>HOSTED_CREDENTIAL_KEY</code>). You can enable the
          flag, but saving credentials is refused until a key is set.
        </div>
      )}

      <div className="settings-toggle-row">
        <div className="settings-toggle-text">
          <span className="settings-toggle-title">Enable unattended provisioning</span>
          <span className="muted small">Off by default. When on, the control plane provisions per your queue routing.</span>
        </div>
        <Toggle
          checked={enabled}
          disabled={busy}
          onChange={(next) => {
            if (next) setConfirmEnable(true);
            else void save({ enabled: false });
          }}
          label="Enable unattended provisioning"
        />
      </div>

      {enabled && (
        <>
          <h4 className="settings-subhead">GitHub credential</h4>
          <p className="muted small">
            Current: <span className="chip">{status?.credential === "app" ? `GitHub App ${status.githubAppId ?? ""}` : status?.credential === "pat" ? "Personal token" : "none"}</span>
            {" "}A GitHub App is recommended — the control plane mints a fresh, short-lived installation token per run instead of holding a long-lived token.
          </p>
          <label className="field-label"><span>Credential type</span>
            <select className="picker-search" value={mode} onChange={(e) => setMode(e.target.value as "app" | "pat")}>
              <option value="app">GitHub App (recommended)</option>
              <option value="pat">Personal access token</option>
            </select>
          </label>
          {mode === "app" ? (
            <>
              <label className="field-label"><span>App ID</span>
                <input className="picker-search" value={appId} placeholder="123456" onChange={(e) => setAppId(e.target.value)} />
              </label>
              <label className="field-label"><span>Installation ID</span>
                <input className="picker-search" value={installationId} placeholder="789012" onChange={(e) => setInstallationId(e.target.value)} />
              </label>
              <label className="field-label"><span>Private key (PEM)</span>
                <textarea className="picker-search" rows={4} value={privateKeyPem} placeholder="-----BEGIN RSA PRIVATE KEY-----" onChange={(e) => setPrivateKeyPem(e.target.value)} />
              </label>
              <button
                className="btn primary"
                disabled={busy || !canSaveSecrets || !appId.trim() || !installationId.trim() || !privateKeyPem.trim()}
                onClick={() => save({ githubApp: { appId: appId.trim(), installationId: installationId.trim(), privateKeyPem } }, () => { setAppId(""); setInstallationId(""); setPrivateKeyPem(""); })}
              >
                {busy ? "Saving…" : "Save GitHub App"}
              </button>
            </>
          ) : (
            <>
              <label className="field-label"><span>Fine-grained token (Contents + Pull requests)</span>
                <input className="picker-search" type="password" value={pat} placeholder="github_pat_…" onChange={(e) => setPat(e.target.value)} />
              </label>
              <button className="btn primary" disabled={busy || !canSaveSecrets || !pat.trim()} onClick={() => save({ githubToken: pat.trim() }, () => setPat(""))}>
                {busy ? "Saving…" : "Save token"}
              </button>
            </>
          )}

          <h4 className="settings-subhead">Cloud provider token</h4>
          <p className="muted small">Configured: {status?.providers.length ? status.providers.map((p) => <span key={p} className="chip">{p}</span>) : <span className="muted">none</span>}</p>
          <label className="field-label"><span>Provider</span>
            <select className="picker-search" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {HOSTED_PROVIDERS.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
            </select>
          </label>
          <label className="field-label"><span>Token</span>
            <input className="picker-search" type="password" value={providerToken} placeholder="provider API token" onChange={(e) => setProviderToken(e.target.value)} />
          </label>
          <button className="btn primary" disabled={busy || !canSaveSecrets || !providerToken.trim()} onClick={() => save({ providerTokens: { [provider]: providerToken.trim() } }, () => setProviderToken(""))}>
            {busy ? "Saving…" : `Save ${provider} token`}
          </button>

          <h4 className="settings-subhead">Encryption</h4>
          <p className="muted small">
            Credentials are encrypted at rest{status?.keyId ? <> under key <span className="chip">{status.keyId}</span></> : ""}. Rotating re-seals them under the current primary key.
          </p>
          <div className="row-actions">
            <button className="btn" disabled={busy || !canSaveSecrets} onClick={rotate}>Rotate encryption key</button>
          </div>

          <h4 className="settings-subhead">Check</h4>
          <div className="row-actions">
            <button className="btn" disabled={busy} onClick={runTest}>Dry-run the provisioning decision</button>
            {testMsg && <span className="chip ok">{testMsg}</span>}
          </div>

          <h4 className="settings-subhead">Audit</h4>
          <div className="picker-list">
            {audit.length === 0 && <div className="picker-empty">No credential activity yet.</div>}
            {audit.map((e, i) => (
              <PickerItem
                key={`${e.at}-${i}`}
                title={e.action}
                meta={[new Date(e.at).toLocaleString(), e.provider, e.nodeId, e.detail].filter(Boolean).join(" · ")}
              />
            ))}
          </div>
        </>
      )}
      {err && <span className="chip err">{err}</span>}
      {confirmEnable && (
        <ConfirmDialog
          title="Enable billable unattended runners?"
          message="When queued work matches your routing policy, the control plane may launch the selected cloud config without another prompt. Your cloud provider bills its displayed hourly rate until teardown; each config's region, size, finish-teardown setting, and TTL backstop control that window. Review the config and use Dry run before relying on it."
          confirmLabel="Enable provisioning"
          onCancel={() => setConfirmEnable(false)}
          onConfirm={() => { setConfirmEnable(false); void save({ enabled: true }); }}
        />
      )}
    </>
  );
}

// ---- Linear issue integration ----
function LinearPanel() {
  const [hook, setHook] = useState<LinearHook | null>(null);
  const [secret, setSecret] = useState("");
  const [route, setRoute] = useState("");
  const [nodes, setNodes] = useState<AccountNode[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    fetchLinearHook(controller.local).then((next) => {
      setHook(next);
      if (next?.defaultNode) setRoute(next.defaultNode);
    }).catch((e) => setError(e instanceof Error ? e.message : "Could not load Linear integration."));
    controller.listNodes().then(setNodes).catch(() => {});
  }, []);
  const createEndpoint = async () => {
    setBusy(true); setError("");
    try { setHook(await connectLinearHook(controller.local, { defaultNode: route || undefined })); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not create Linear endpoint."); }
    finally { setBusy(false); }
  };
  const connect = async () => {
    setBusy(true); setError("");
    try {
      setHook(await connectLinearHook(controller.local, { signingSecret: secret, defaultNode: route || undefined }));
      setSecret("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not connect Linear."); }
    finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!confirm("Disconnect Linear? Its webhook URL will stop accepting issues.")) return;
    setBusy(true); setError("");
    try { await disconnectLinearHook(controller.local); setHook(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not disconnect Linear."); }
    finally { setBusy(false); }
  };
  return (
    <div className="settings-form">
      <p className="settings-lead">Turn labelled Linear issues into unattended coding sessions and GitHub pull requests.</p>
      {error && <div className="banner error inline">{error}</div>}
      {!hook ? (
        <section className="settings-section">
          <h3>Connect Linear</h3>
          <p className="settings-hint">First create a Bivy webhook URL. You will paste it into Linear, then bring Linear's generated signing secret back here.</p>
          <label className="field-label">Default node (optional)</label>
          <NodeRouteSelect nodes={nodes} value={route} onChange={setRoute} disabled={busy} />
          <button className="btn primary" disabled={busy} onClick={() => void createEndpoint()}>Create webhook URL</button>
        </section>
      ) : (
        <section className="settings-section">
          <h3>{hook.enabled ? "Connected" : "Finish connecting"}</h3>
          <ol className="settings-hint">
            <li>In <strong>Linear → Settings → API → Webhooks</strong>, create an <strong>Issue</strong> webhook using this URL:</li>
          </ol>
          <code className="settings-code">{hook.endpoint}</code>
          <button className="btn" onClick={() => void navigator.clipboard.writeText(hook.endpoint)}>Copy webhook URL</button>
          <ol className="settings-hint" start={2}>
            <li>Copy the signing secret generated by Linear and paste it below.</li>
            <li>Create Linear labels <code>bivy</code> and optionally <code>bivy/node-name</code>. Applying one dispatches the issue.</li>
          </ol>
          <label className="field-label">Linear signing secret</label>
          <input className="field-input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={hook.enabled ? "Replace signing secret" : "Signing secret"} />
          <label className="field-label">Default node (optional)</label>
          <NodeRouteSelect nodes={nodes} value={route} onChange={setRoute} disabled={busy} />
          <button className="btn primary" disabled={busy || secret.trim().length < 16} onClick={() => void connect()}>{hook.enabled ? "Update connection" : "Connect Linear"}</button>
          <p className="settings-hint">Each runner also needs <code>BIVY_LINEAR_API_KEY</code> and a default <code>BIVY_LINEAR_REPO=owner/repo</code>. A <code>repo:owner/repo</code> issue label can override the repository.</p>
          <button className="btn danger" disabled={busy} onClick={() => void disconnect()}>Disconnect Linear</button>
        </section>
      )}
    </div>
  );
}

// ---- Slack slash-command integration ----
function SlackPanel() {
  const [hook, setHook] = useState<SlackHook | null>(null);
  const [secret, setSecret] = useState("");
  const [route, setRoute] = useState("");
  const [nodes, setNodes] = useState<AccountNode[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => {
    try {
      const next = await fetchSlackHook(controller.local);
      setHook(next);
      if (next?.defaultNode) setRoute(next.defaultNode);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load Slack integration.");
    }
  };
  useEffect(() => {
    void refresh();
    controller.listNodes().then(setNodes).catch(() => {});
  }, []);
  const connect = async () => {
    setBusy(true); setError("");
    try {
      setHook(await connectSlackHook(controller.local, { signingSecret: secret, defaultNode: route || undefined }));
      setSecret("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect Slack.");
    } finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!confirm("Disconnect Slack? The current slash-command URL will stop accepting requests.")) return;
    setBusy(true); setError("");
    try {
      await disconnectSlackHook(controller.local);
      setHook(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect Slack.");
    } finally { setBusy(false); }
  };
  return (
    <div className="settings-form">
      <p className="settings-lead">Turn requests from a Slack slash command into unattended agent runs on your nodes.</p>
      {error && <div className="banner error inline">{error}</div>}
      {hook ? (
        <section className="settings-section">
          <h3>Connected</h3>
          <p className="settings-hint">Use this as your Slack app's slash-command Request URL:</p>
          <code className="settings-code">{hook.endpoint}</code>
          <button className="btn" onClick={() => void navigator.clipboard.writeText(hook.endpoint)}>Copy Request URL</button>
          <h4 className="settings-subhead">Commands</h4>
          <code className="settings-code">/bivy fix the failing tests</code>
          <code className="settings-code">/bivy on macbook fix the failing tests</code>
          <code className="settings-code">/bivy in owner/repo fix the failing tests</code>
          <p className="settings-hint">Add <code>in owner/repo</code> to run in an isolated checkout and bring back a pull request. Add <code>on node</code> to select a machine; the clauses can be combined.</p>
          <button className="btn danger" disabled={busy} onClick={() => void disconnect()}>Disconnect Slack</button>
        </section>
      ) : (
        <section className="settings-section">
          <h3>Connect a Slack app</h3>
          <ol className="settings-hint">
            <li>Create a Slack app, then open <strong>Basic Information</strong>.</li>
            <li>Copy its <strong>Signing Secret</strong> below.</li>
            <li>After connecting, create a slash command named <code>/bivy</code> and paste the Request URL shown here.</li>
          </ol>
          <label className="field-label">Slack signing secret</label>
          <input className="field-input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Signing Secret" />
          <label className="field-label">Default node (optional)</label>
          <NodeRouteSelect nodes={nodes} value={route} onChange={setRoute} disabled={busy} />
          <button className="btn primary" disabled={busy || secret.trim().length < 16} onClick={() => void connect()}>Connect Slack</button>
        </section>
      )}
    </div>
  );
}

// ---- Generic signed automation webhooks ----
// Signed inbound webhook triggers (from the automation-webhooks feature). Its
// own "Webhooks" settings view, a sibling of the scheduled-automations panel
// (imported from ./Automations) — the two used to share one "Automations" view
// but were split into separate screens since they're independent features.
function WebhookTriggersPanel() {
  const [hooks, setHooks] = useState<AutomationHook[]>([]);
  const [outcomes, setOutcomes] = useState<AutomationOutcome[]>([]);
  const [template, setTemplate] = useState("Follow the incoming instruction in the current workspace.");
  const [route, setRoute] = useState("");
  const [nodes, setNodes] = useState<AccountNode[]>([]);
  const [revealed, setRevealed] = useState<{ hook: AutomationHook; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => {
    try {
      const data = await fetchAutomationHooks(controller.local);
      setHooks(data.hooks);
      setOutcomes(data.outcomes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load automation hooks.");
    }
  };
  useEffect(() => {
    void refresh();
    controller.listNodes().then(setNodes).catch(() => {});
  }, []);
  const updateHookRoute = (hook: AutomationHook, next: string) => {
    void updateAutomationHook(controller.local, hook.id, { routingDefault: next })
      .then(refresh)
      .catch((err) => setError(String(err)));
  };
  const create = async () => {
    setBusy(true); setError("");
    try {
      const created = await createAutomationHook(controller.local, { templateInstruction: template, routingDefault: route });
      setRevealed({ hook: created, secret: created.secret });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create hook.");
    } finally { setBusy(false); }
  };
  const rotate = async (hook: AutomationHook) => {
    setBusy(true); setError("");
    try {
      const rotated = await rotateAutomationHookSecret(controller.local, hook.id);
      setRevealed({ hook: rotated, secret: rotated.secret });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rotate secret.");
    } finally { setBusy(false); }
  };
  const curl = revealed ? `body='{"version":"1","instruction":"Run the test suite","title":"CI follow-up","sourceUrl":"https://example.com/build/123","externalId":"build-123","metadata":{"environment":"staging"}}'
signature=$(printf %s "$body" | openssl dgst -sha256 -hmac '${revealed.secret}' -hex | sed 's/^.* //')
curl -X POST '${revealed.hook.endpoint}' \\
  -H 'Content-Type: application/json' \\
  -H "X-Bivy-Signature-256: sha256=$signature" \\
  -H 'X-Bivy-Idempotency-Key: build-123' \\
  --data-binary "$body"` : "";
  return (
    <div className="settings-form">
      <p className="settings-lead">Create signed inbound endpoints that turn events from CI, monitoring, or internal tools into ordinary Bivy runs.</p>
      {error && <div className="banner error inline">{error}</div>}
      {revealed && (
        <section className="settings-section">
          <h3>Save this secret now</h3>
          <p className="settings-hint">It is shown only after creation or rotation. Rotating immediately invalidates the previous secret.</p>
          <code className="settings-code">{revealed.secret}</code>
          <h4 className="settings-subhead">Example curl</h4>
          <pre className="settings-code" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{curl}</pre>
          <button className="btn" onClick={() => void navigator.clipboard.writeText(curl)}>Copy example</button>
        </section>
      )}
      <section className="settings-section">
        <h3>New webhook</h3>
        <label className="field-label">Safe instruction template</label>
        <textarea className="field-input" rows={3} value={template} maxLength={2000} onChange={(e) => setTemplate(e.target.value)} />
        <p className="settings-hint">This fixed instruction is prepended to each event. Payloads cannot select commands, runtimes, models, or executable templates.</p>
        <label className="field-label">Default node (optional)</label>
        <NodeRouteSelect nodes={nodes} value={route} onChange={setRoute} disabled={busy} />
        <button className="btn primary" disabled={busy || !template.trim()} onClick={() => void create()}>Create webhook</button>
      </section>
      {EPHEMERAL_MACHINES_ENABLED && (
        <section className="settings-section">
          <h4 className="settings-subhead">Queue routing</h4>
          <QueueRoutingSection />
        </section>
      )}
      {hooks.map((hook) => (
        <section className="settings-section" key={hook.id}>
          <div className="settings-row">
            <div><h3>{hook.id}</h3><code className="settings-code">{hook.endpoint}</code></div>
            <label><input type="checkbox" checked={hook.enabled} disabled={busy} onChange={(e) => {
              void updateAutomationHook(controller.local, hook.id, { enabled: e.target.checked }).then(refresh).catch((err) => setError(String(err)));
            }} /> Enabled</label>
          </div>
          <label className="field-label">Default node</label>
          <NodeRouteSelect nodes={nodes} value={hook.routingDefault} onChange={(v) => updateHookRoute(hook, v)} disabled={busy} />
          <p className="settings-hint">Routes to {hook.routingDefault ? `bivy/${hook.routingDefault}` : "the shared bivy queue"}.</p>
          <div className="settings-actions">
            <button className="btn" disabled={busy} onClick={() => void rotate(hook)}>Rotate secret</button>
            <button className="btn danger" disabled={busy || !hook.enabled} onClick={() => {
              if (confirm("Revoke this webhook? Its current secret will stop working immediately.")) {
                void revokeAutomationHook(controller.local, hook.id).then(refresh).catch((err) => setError(String(err)));
              }
            }}>Revoke</button>
          </div>
        </section>
      ))}
      <section className="settings-section">
        <h3>Recent trigger outcomes</h3>
        {outcomes.length === 0
          ? <p className="settings-hint">No accepted triggers yet.</p>
          : outcomes.map((outcome) => <div className="settings-row" key={outcome.id}><span>{outcome.title}</span><span className="settings-hint">{outcome.status}</span></div>)}
      </section>
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
  const [triggerAccess, setTriggerAccess] = useState<"everyone" | "contributor" | "collaborator">("everyone");
  const [savingTriggerAccess, setSavingTriggerAccess] = useState(false);
  const [triggerAccessMsg, setTriggerAccessMsg] = useState<string | null>(null);
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

  const refresh = useCallback(() => {
    if (!canQuery) return;
    controller.fetchGithubApp().then(setInfo).catch(() => setInfo(null));
    controller.listNodes().then(setNodes).catch(() => {});
  }, [canQuery]);
  useEffect(() => { refresh(); }, [refresh]);
  // Re-pull once the create flow reports success, so "connected" appears without
  // a manual reload.
  useEffect(() => {
    if (phase === "done") refresh();
  }, [phase, refresh]);
  const apps = info?.apps ?? [];
  // The default node is one account-level setting written to every app, so any
  // app that has it answers for all of them.
  const storedDefaultNode = apps.find((a) => a.defaultNode)?.defaultNode ?? "";
  // Seed the editable field from the account's stored default whenever it
  // changes (initial load, or after a save round-trip elsewhere).
  useEffect(() => { setDefaultNode(storedDefaultNode); }, [storedDefaultNode]);
  // Same account-wide-preference pattern as the default node: any app that has
  // it set answers for all of them; "everyone" (no restriction) if none do.
  const storedTriggerAccess = apps.find((a) => a.triggerAccess)?.triggerAccess ?? "everyone";
  useEffect(() => { setTriggerAccess(storedTriggerAccess); }, [storedTriggerAccess]);

  // The apps share the same routing copy; show the first one's handle as the example.
  const primaryMention = apps.find((a) => a.mention)?.mention;
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
  const saveTriggerAccess = async (next: "everyone" | "contributor" | "collaborator") => {
    setTriggerAccessMsg(null);
    setSavingTriggerAccess(true);
    const prev = triggerAccess;
    setTriggerAccess(next); // optimistic — it's a plain select, not a form submit
    try {
      const saved = await controller.setGithubAppTriggerAccess(next);
      setInfo((cur) => (cur ? { ...cur, triggerAccess: saved, apps: cur.apps.map((a) => ({ ...a, triggerAccess: saved })) } : cur));
      setTriggerAccessMsg("Saved");
      setTimeout(() => setTriggerAccessMsg(null), 1500);
    } catch (e) {
      setTriggerAccess(prev);
      setTriggerAccessMsg(String((e as Error)?.message || e));
    } finally {
      setSavingTriggerAccess(false);
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
            <NodeRouteSelect nodes={nodes} value={defaultNode} onChange={setDefaultNode} />
            <div className="row-actions">
              <button className="btn primary" disabled={savingDefaultNode} onClick={saveDefaultNode}>
                {savingDefaultNode ? "Saving…" : "Save"}
              </button>
              {defaultNodeMsg && <span className="chip ok">{defaultNodeMsg}</span>}
            </div>
          </section>

          <section className="settings-section">
            <h4 className="settings-subhead">Who can trigger runs</h4>
            <p className="muted">
              On a public repository, anyone can open an issue or leave a comment — by default,{" "}
              <code>@{primaryMention || "mention"}</code>-ing the bot there queues a run for whoever wrote it. Restrict
              this to people GitHub already trusts with the repo. One setting for the whole account: it applies to
              every app above.
            </p>
            <select
              className="picker-search"
              value={triggerAccess}
              disabled={savingTriggerAccess}
              onChange={(e) => void saveTriggerAccess(e.target.value as "everyone" | "contributor" | "collaborator")}
            >
              <option value="everyone">Everyone — any GitHub user (default)</option>
              <option value="contributor">Contributors — anyone with a prior merged contribution, or higher</option>
              <option value="collaborator">Collaborators only — push access (collaborator, member, or owner)</option>
            </select>
            {triggerAccessMsg && <span className="chip ok">{triggerAccessMsg}</span>}
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
              <h4 className="settings-subhead">Queue routing</h4>
              <QueueRoutingSection />
            </section>
          )}

          {EPHEMERAL_MACHINES_ENABLED && (
            <section className="settings-section">
              <h4 className="settings-subhead">Unattended provisioning</h4>
              <HostedProvisioningSection />
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
  const currentNodeId = controller.local.cur;
  const selectedNode = nodes.find((node) => node.id === currentNodeId);
  const selectedLastSeen = typeof selectedNode?.lastSeenAt === "string" ? Date.parse(selectedNode.lastSeenAt) : NaN;
  const selectedHealth = selectedNode?.online
    ? "Connected now."
    : Number.isFinite(selectedLastSeen)
      ? `Last contact ${new Date(selectedLastSeen).toLocaleString()}. The daemon may be stopped, updating, asleep, or unable to reach the control plane.`
      : "This node has not completed a control-plane heartbeat yet. Check that the daemon is running and can reach the network.";

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
  // Intentionally keyed on `sig`, not `settings`: re-seed the form only when the
  // signature changes (a real node/settings switch), so a new `settings` object
  // identity from an unrelated re-render doesn't clobber an in-progress edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
        sessionResumeMode: form.sessionResumeMode,
        autoAttachToolImages: form.autoAttachToolImages,
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
      {hosted && (
        <section className="settings-section">
          <label className="field-label" htmlFor="node-settings-node">Node</label>
          <select
            id="node-settings-node"
            className="picker-search"
            value={currentNodeId ?? ""}
            disabled={nodes.length === 0}
            onChange={(e) => {
              const nodeId = e.target.value;
              if (!nodeId || nodeId === currentNodeId) return;
              controller.switchNode(nodeId);
              // Don't show the outgoing node's settings a moment longer than
              // necessary. The effect above pulls the new node's settings
              // once the transport actually confirms it's online — no fixed
              // timeout guess, and no window where a picked *offline* node
              // would keep displaying whatever was left over from before.
              setForm(null);
            }}
          >
            {nodes.length === 0 && <option value="">No nodes found</option>}
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name || n.id}{n.online ? "" : " (offline)"}
              </option>
            ))}
          </select>
          {selectedNode && <p className={`muted small${selectedNode.online ? "" : " warn-text"}`}>{selectedHealth}</p>}
          <p className="muted small">Run <code>bivy update</code> on the node to update or repair its service, then refresh this list.</p>
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
            <h4 className="settings-subhead">Session resume</h4>
            <label className="field-label">After a restart interrupts a session</label>
            <div className="seg-row">
              {([
                { id: "auto", label: "Auto-resume", hint: "The agent automatically continues the interrupted turn when the node restarts." },
                { id: "manual", label: "Manual", hint: "The interrupted session waits and offers a one-tap Resume when you open it." },
              ] as const).map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={`seg-btn${form.sessionResumeMode === o.id ? " active" : ""}`}
                  onClick={() => setForm({ ...form, sessionResumeMode: o.id })}
                  title={o.hint}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="muted small">
              {form.sessionResumeMode === "manual"
                ? "Interrupted sessions wait for you to tap Resume — nothing runs on its own. GitHub issue automation still resumes automatically."
                : "The agent picks up an interrupted turn on its own after the node restarts."}
            </p>
          </section>

          <section className="settings-section">
            <h4 className="settings-subhead">Attachments</h4>
            <div className="settings-toggle-row">
              <div className="settings-toggle-text">
                <span className="settings-toggle-title">Auto-attach images from tool results</span>
                <span className="muted small">
                  When a tool the agent runs returns an image — a screenshot from a browser-automation tool, say —
                  show it in the chat automatically, with no explicit attach step. Bounded per turn so a chatty tool
                  can't flood the chat.
                </span>
              </div>
              <Toggle
                checked={form.autoAttachToolImages}
                onChange={(v) => setForm({ ...form, autoAttachToolImages: v })}
                label="Enable auto-attach for tool images"
              />
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
  const [setups, setSetups] = useState<EphemeralNodeConfig[]>([]);
  // Which machine we've drilled into to edit. `setupId: null` = a fresh machine
  // for that provider; a string = editing an existing one. `null` nav = the
  // list view.
  const [nav, setNav] = useState<{ provider: string; setupId: string | null } | null>(null);
  const refreshKeys = () => controller.listEphemeralKeys().then(setKeys).catch(() => {});
  // Account-level ephemeral configs — the same records the new-session node
  // picker lists, so a machine saved here shows up there (and syncs across the
  // account's devices). The provider token stays device-local (below).
  const refreshSetups = () => controller.listEphemeralConfigs().then(setSetups).catch(() => {});
  // One-time migration: earlier builds saved machines as device-local "setups"
  // (invisible to the node picker, which reads account-level configs). Copy any
  // legacy setup that doesn't already have a matching config to the account,
  // then drop the device-local copy so it can't resurrect. Idempotent and
  // best-effort — the panel works regardless of whether this runs.
  const migrateLegacySetups = async () => {
    try {
      const [legacy, configs] = await Promise.all([
        controller.listEphemeralSetups(),
        controller.listEphemeralConfigs(),
      ]);
      if (!legacy.length) return;
      const have = new Set(configs.map((c) => `${c.provider} ${c.name}`));
      for (const s of legacy) {
        if (!have.has(`${s.provider} ${s.name}`)) {
          await controller.createEphemeralConfig({
            provider: s.provider, name: s.name,
            region: s.region ?? null, size: s.size ?? null,
            ttlMinutes: s.ttlMinutes ?? null,
            teardownOnAgentFinish: s.teardownOnAgentFinish === true,
          });
        }
        await controller.removeEphemeralSetup(s.id).catch(() => {});
      }
      refreshSetups();
    } catch { /* best effort */ }
  };
  useEffect(() => {
    refreshKeys();
    refreshSetups();
    void migrateLegacySetups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const catalog = nav ? EPHEMERAL_PROVIDERS.find((p) => p.id === nav.provider) : undefined;
  if (nav && catalog) {
    return (
      <div className="settings-form">
        <button className="link-btn" onClick={() => { setNav(null); refreshSetups(); refreshKeys(); }}>‹ Ephemeral machines</button>
        <h3>{catalog.name}</h3>
        <EphemeralProviderConfig
          providerId={catalog.id}
          initialSetupId={nav.setupId}
          onKeysChanged={refreshKeys}
          onSetupsChanged={refreshSetups}
          onBack={() => { setNav(null); refreshSetups(); refreshKeys(); }}
        />
      </div>
    );
  }

  return (
    <div className="settings-form">
      <p className="muted settings-intro">
        Bring your own cloud token to spin up temporary nodes that self-destruct at their TTL. Each configured machine
        below is a saved setup — its provider, region, server type and auto-destroy time — that the new-session node
        picker offers to launch. The repo it works on comes from the composer, not from here. Tap one to edit it.
      </p>
      {setups.length > 0 && (
        <>
          <label className="field-label">Configured machines</label>
          <div className="picker-list">
            {setups.map((setup) => {
              const p = EPHEMERAL_PROVIDERS.find((x) => x.id === setup.provider);
              return (
                <PickerItem
                  key={setup.id}
                  title={setup.name}
                  meta={[p?.name, setup.region, setup.size, setup.teardownOnAgentFinish ? "until agent finishes" : setup.ttlMinutes ? `${setup.ttlMinutes} min` : null].filter(Boolean).join(" · ")}
                  right={<span className="chip">Edit</span>}
                  onClick={() => setNav({ provider: setup.provider, setupId: setup.id })}
                />
              );
            })}
          </div>
        </>
      )}
      <label className="field-label">{setups.length > 0 ? "Add a machine" : "Choose a provider"}</label>
      <div className="picker-list">
        {EPHEMERAL_PROVIDERS.map((p) => {
          const k = keys.find((x) => x.id === p.id);
          return (
            <PickerItem
              key={p.id}
              title={p.name}
              meta={p.blurb}
              right={k?.configured ? <span className="chip ok">Token saved</span> : <span className="chip">Not set up</span>}
              onClick={() => setNav({ provider: p.id, setupId: null })}
            />
          );
        })}
      </div>
      <EphemeralTokenSync />
      <EphemeralModelKeys />
    </div>
  );
}

// Opt-in: sync provider tokens to the account's OTHER devices via an E2E device
// vault, so a second device can wake/reach a machine this one launched (P2 /
// Gap A). Off by default; the control plane only ever stores ciphertext.
function EphemeralTokenSync() {
  const [on, setOn] = useState(false);
  useEffect(() => { setOn(controller.getDeviceTokenSync()); }, []);
  return (
    <div className="settings-form" style={{ marginTop: "1rem" }}>
      <Toggle
        checked={on}
        onChange={(v) => { controller.setDeviceTokenSync(v); setOn(v); }}
        label="Sync provider tokens across my devices"
      />
      <p className="muted small">
        End-to-end encrypted, opt-in. Lets your other signed-in devices wake and reach machines you launch here without
        re-entering the token — the control plane only ever stores ciphertext. A brand-new device receives the token the
        next time an existing device is opened.
      </p>
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
  const [err, setErr] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const refresh = () => controller.listEphemeralModelKeys().then(setKeys).catch(() => {});
  useEffect(() => { refresh(); }, []);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await controller.setEphemeralModelKey(provider, key);
      setProvider("");
      setKey("");
      setMsg("Saved on this device.");
      refresh();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
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
                    setConfirmRemove(k.provider);
                  }}
                >
                  Remove
                </button>
              }
            />
          ))}
        </div>
      )}
      {confirmRemove && (
        <ConfirmDialog
          title="Remove model key?"
          message={`Forget the ${confirmRemove} model key on this device? New machines won't be seeded with it.`}
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            const p = confirmRemove;
            setConfirmRemove(null);
            controller.removeEphemeralModelKey(p).then(refresh).catch((e) => setErr(String((e as Error)?.message || e)));
          }}
        />
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
      {err && <span className="chip err">{err}</span>}
      {msg && <p className="muted">{msg}</p>}
    </section>
  );
}

function EphemeralProviderConfig({ providerId, initialSetupId, onKeysChanged, onSetupsChanged, onBack }: { providerId: string; initialSetupId: string | null; onKeysChanged: () => void; onSetupsChanged: () => void; onBack: () => void }) {
  const catalog = EPHEMERAL_PROVIDERS.find((p) => p.id === providerId)!;
  const adapter = ephemeralAdapter(providerId)!;
  // Suspend-to-zero providers (Fly Sprites) keep the machine and self-suspend
  // when idle — so TTL self-destruct and destroy-on-finish don't apply.
  const suspendsWhenIdle = adapter.suspendsWhenIdle === true;
  const [confirm, setConfirm] = useState<null | { title: string; message: string; label?: string; action: () => void }>(null);
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [region, setRegion] = useState(adapter.defaultRegion);
  const [sizes, setSizes] = useState<ProviderSize[]>(adapter.sizes);
  const [size, setSize] = useState(adapter.defaultSize);
  const [ttl, setTtl] = useState(60);
  const [teardownOnAgentFinish, setTeardownOnAgentFinish] = useState(false);
  // The single machine being edited: `null` = a brand-new one. The list of all
  // configured machines lives one level up in EphemeralPanel, so this view is
  // just the editor — never a mix of a list plus an always-open form.
  const [setupId, setSetupId] = useState<string | null>(null);
  const [setupName, setSetupName] = useState("");
  const [machines, setMachines] = useState<EphemeralMachine[]>([]);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Failures render as a `chip err` — kept separate from the neutral `msg` so a
  // token/save error doesn't read like a calm status line.
  const [err, setErr] = useState<string | null>(null);
  // Both saveToken and savePrefs are already real awaited requests — the
  // missing piece was an in-flight guard against a double-submit (#140).
  const [busy, setBusy] = useState(false);

  const refreshMachines = () =>
    controller.listEphemeralMachines().then((all) => setMachines(all.filter((m) => m.provider === providerId))).catch(() => {});
  const editSetup = (setup: EphemeralNodeConfig | null) => {
    setSetupId(setup?.id ?? null);
    setSetupName(setup?.name ?? "");
    setRegion(setup?.region || adapter.defaultRegion);
    setSize(setup?.size || adapter.defaultSize);
    setTtl(setup?.ttlMinutes ?? 60);
    setTeardownOnAgentFinish(setup?.teardownOnAgentFinish === true);
  };

  // Seed the form from the saved token + the machine we drilled in to edit (or a
  // blank form when adding).
  useEffect(() => {
    controller.getEphemeralToken(providerId).then((t) => setHasToken(Boolean(t))).catch(() => {});
    controller.listEphemeralConfigs().then((rows) => {
      editSetup(initialSetupId ? rows.find((s) => s.id === initialSetupId) ?? null : null);
    }).catch(() => {});
    refreshMachines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, initialSetupId]);

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
    setErr(null);
    try {
      await controller.setEphemeralToken(providerId, token.trim());
      setToken("");
      setHasToken(true);
      onKeysChanged();
      setMsg("Token saved on this device.");
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  const savePrefs = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      // Repo isn't a machine setting — it comes from the new-session composer at
      // launch time — so it's never part of a saved config.
      const values = { name: setupName.trim(), region, size, ttlMinutes: ttl, teardownOnAgentFinish };
      if (setupId) await controller.updateEphemeralConfig(setupId, values);
      else {
        const created = await controller.createEphemeralConfig({ provider: providerId, ...values });
        setSetupId(created.id);
      }
      onSetupsChanged();
      setSavedMsg("Saved");
      setTimeout(() => setSavedMsg(null), 1500);
    } catch (e) {
      setErr(String((e as Error).message || e));
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
            {setupId
              ? "Edit this machine. It stays in the new-session launcher like an offline node even after its machine expires."
              : "Name this machine and set its defaults. It'll stay in the new-session launcher like an offline node even after its machine expires."}
          </p>
          <label className="field-label">Machine name</label>
          <input className="picker-search" value={setupName} onChange={(e) => setSetupName(e.target.value)} placeholder="e.g. EU coding node" />

          <label className="field-label">Region</label>
          <select className="picker-search" value={region} onChange={(e) => setRegion(e.target.value)}>
            {adapter.regions.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>

          <label className="field-label">Server type</label>
          <select className="picker-search" value={size} onChange={(e) => setSize(e.target.value)}>
            {sizes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>

          {!suspendsWhenIdle && (
            <>
              <label className="field-label">Auto-destroy after (TTL)</label>
              <select className="picker-search" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
                {EPHEMERAL_TTL_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
              </select>
            </>
          )}
          {(() => {
            const selected = sizes.find((s) => s.id === size);
            const hint = ephemeralCostHint(selected, suspendsWhenIdle ? undefined : ttl, adapter.currency);
            if (!hint) return null;
            return suspendsWhenIdle
              ? <p className="muted small">{hint} while active · ~$0 while suspended · billed by {catalog.name}, not Bivy</p>
              : <p className="muted small">{hint} · billed by {catalog.name}, not Bivy</p>;
          })()}

          {suspendsWhenIdle ? (
            <p className="muted small">Keeps its memory: suspends to ~$0 when idle and resumes with everything intact. Reopen its session from the node list to wake it — no TTL, no teardown-on-finish.</p>
          ) : (
            <>
              <label className="field-label">Work until finished</label>
              <label className="checkbox-row">
                <input type="checkbox" checked={teardownOnAgentFinish} onChange={(e) => setTeardownOnAgentFinish(e.target.checked)} />
                <span>Destroy the machine once the agent finishes its work <span className="muted small">(the TTL above stays a safety fallback; the launching device must be online)</span></span>
              </label>
            </>
          )}

          <p className="muted small">The repo this machine works on is whatever you pick in the new-session composer — it isn't set here.</p>

          <div className="row-actions">
            <button className="btn primary" disabled={busy || !setupName.trim()} onClick={savePrefs}>{busy ? "Saving…" : setupId ? "Save machine" : "Create machine"}</button>
            {savedMsg && <span className="chip ok">{savedMsg}</span>}
            {setupId && (
              <button className="btn danger-ghost" onClick={() => setConfirm({
                title: "Remove machine?",
                message: `Remove ${setupName}? Running machines are not affected.`,
                label: "Remove",
                action: () => controller.removeEphemeralConfig(setupId).then(() => { onSetupsChanged(); onBack(); }),
              })}>Remove machine</button>
            )}
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
      {err && <span className="chip err">{err}</span>}
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
                        action: () => controller.destroyEphemeral(m).then(refreshMachines).catch((e) => setErr(String((e as Error)?.message || e))),
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
  // Free caps unattended automation per rolling window, plus a lifetime hosted-session
  // trial (present only on Bivy Cloud free accounts — absent when self-hosting or paid).
  const runCap = ent ? (ent.weeklyRunLimit ?? "∞") : "—";
  const trial = me?.trial;
  const sessionCap = trial ? `${trial.used} / ${trial.limit ?? "∞"}` : "∞";
  const proPrice = me?.pricing?.pro?.label;
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
        {trial && <Stat label="Pro trial" value={sessionCap} />}
        <Stat label="Automations / week" value={`${counts?.runsThisWeek ?? "—"} / ${runCap}`} />
      </div>
      {free && trial && (
        <p className="muted settings-intro">
          You're on the Pro free trial — your first {trial.limit} sessions on Bivy Cloud are free
          {typeof trial.remaining === "number" && trial.remaining !== Infinity ? ` (${trial.remaining} left)` : ""}.
          Subscribe to Pro to keep unlimited sessions{proPrice ? ` for ${proPrice}` : ""} — or run your own self-hosted Bivy server to keep everything free.
        </p>
      )}
      {free && !trial && (
        <p className="muted settings-intro">
          You're on the free plan — interactive sessions are unlimited, with {runCap} unattended automations
          per rolling 7 days across GitHub, Slack, webhooks, and schedules. Pro removes the automation cap{proPrice ? ` for ${proPrice}` : ""}.
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
            {opening ? "Opening…" : `Upgrade to Pro${proPrice ? ` — ${proPrice}` : ""}`}
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
