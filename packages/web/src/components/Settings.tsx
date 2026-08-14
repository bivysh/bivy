// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AccountMe, AccountNode, AppState, CredentialPresetsView, CredentialRecordSummary, EphemeralNodeConfig, LocalModelPreset, LocalModelProvider, PairedDevice, NodeSettings, NotificationPreferences, SandboxTier, EphemeralMachine, EphemeralModelKeyInfo, ProviderKeyInfo, ProviderSize, HostedAuditEvent, HostedMachineSummary, HostedProvisioningStatus } from "@bivy/core";
import { NOTIFICATION_KIND_META, EPHEMERAL_PROVIDERS, ephemeralAdapter, ephemeralCostHint, ephemeralCostEstimate, ephemeralLifecyclePhase, formatEphemeralPrice, deriveCredentialReadiness } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { PickerItem } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { OauthStep } from "./ProviderConnect.js";
import { ImportSessionContent } from "./ImportSessionSheet.js";
import { currentThemeSetting, setTheme, type ThemeSetting } from "../theme.js";
import { useModalEscape } from "../modalStack.js";
import type { SettingsView } from "../router.js";
import { EPHEMERAL_MACHINES_ENABLED } from "../flags.js";
import { ChevronRightIcon, CloseIcon } from "./UiIcons.js";

const VoiceSettings = lazy(() => import("./VoiceSettings.js").then((module) => ({ default: module.VoiceSettings })));

// The view enumeration lives in router.ts (as `SettingsView`) so the router can
// validate a `/settings/:view` path without importing this component module;
// aliased back to `View` here since it's used throughout as local vocabulary.
type View = SettingsView;

/** Views that moved out of Settings into the Automations hub. They remain valid
 *  `SettingsView` values only so stale `/settings/:view` deep links parse and can
 *  be redirected — they are never listed in the Settings nav. */
type MovedView = "github" | "linear" | "slack" | "queue" | "webhooks" | "rulesets";
const MOVED_TO_AUTOMATIONS: readonly MovedView[] = ["github", "linear", "slack", "queue", "webhooks", "rulesets"];
function isMovedView(v: View | null): v is MovedView {
  return v !== null && (MOVED_TO_AUTOMATIONS as readonly string[]).includes(v);
}

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
const IconUser = () => (
  <Glyph><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Glyph>
);
const IconLink = () => (
  <Glyph><path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 0 1 0 10h-2" /><line x1="8" y1="12" x2="16" y2="12" /></Glyph>
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
  voice: "Voice",
  github: "GitHub App",
  linear: "Linear",
  slack: "Slack",
  queue: "Runs",
  webhooks: "Webhooks",
  rulesets: "Rulesets",
  nodes: "Machines",
  ephemeral: "Isolated machine profiles",
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
  voice: "microphone speech transcription read aloud reader text to speech voice tone speed",
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
  onImported,
  onRedirectToAutomations,
}: {
  state: AppState;
  onClose: () => void;
  /** The active section, driven by the URL (`/settings/:view`) — null is the
   *  mobile root menu (`/settings`). See settingsRoute.ts (#78). */
  view: View | null;
  onViewChange: (view: View | null) => void;
  /** Fired when the Import-session panel adopts a session — the controller has
   *  already opened/navigated to it, so the caller just dismisses Settings. */
  onImported?: (sessionId: string) => void;
  /** Integrations + automation/policy moved to the Automations hub. A stale deep
   *  link to one of those `/settings/:view` URLs redirects there instead. */
  onRedirectToAutomations?: (view: MovedView) => void;
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

  // Integrations + automation/policy sections moved to the Automations hub. A
  // stale deep link (bookmark / OAuth return) to one of those `/settings/:view`
  // URLs bounces there instead of showing an empty panel.
  useEffect(() => {
    if (isMovedView(view)) onRedirectToAutomations?.(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

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
        { id: "nodes", label: "Machines", icon: <IconServer /> },
        ...(EPHEMERAL_MACHINES_ENABLED
          ? [{ id: "ephemeral" as View, label: "Isolated machine profiles", icon: <IconBolt /> }]
          : []),
      ],
    },
    // Integrations (GitHub / Linear / Slack) and automation & policy (Work Queue,
    // Webhooks, Rulesets) now live in the Automations hub — reachable from the
    // sidebar bolt — so Settings no longer lists them.
    {
      label: "App",
      items: [
        { id: "appearance", label: "Appearance", icon: <IconAppearance /> },
        { id: "notifications", label: "Notifications", icon: <IconBell /> },
        { id: "voice", label: "Voice", icon: <IconMic /> },
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
            <button className="settings-x" onClick={onClose} aria-label="Close settings"><CloseIcon /></button>
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
                      <span className="settings-nav-chevron"><ChevronRightIcon size={18} /></span>
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
            <button className="settings-x settings-x-content" onClick={onClose} aria-label="Close settings"><CloseIcon /></button>
          </header>
          <div className="settings-body">
            {activeView === "appearance" && <AppearancePanel />}
            {activeView === "notifications" && <NotificationsPanel />}
            {activeView === "import" && <ImportPanel onImported={(id) => onImported?.(id)} />}
            {activeView === "providers" && <ProvidersPanel state={state} />}
            {activeView === "models" && <LocalModelsPanel state={state} />}
            {activeView === "voice" && (
              <Suspense fallback={<div className="muted">Loading voice settings…</div>}>
                <VoiceSettings state={state} />
              </Suspense>
            )}
            {/* github / linear / slack / queue / webhooks / rulesets moved to the
                Automations hub — a deep link to any of them redirects there (see
                the redirect effect above), so they render nothing here. */}
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
        sessions this machine (or another one you pick) can see and safely take over
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
  if (!nodeId) return "this machine";
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

// Multiple labeled credentials for one provider — work / personal / per-project
// keys, plus password-manager references. The single "API key" field above is the
// provider's `default` credential; this manages the extra labeled ones and each
// one's cross-node sync (the per-credential opt-out).
function ProviderCredentials({ providerId, records, presets, accountEmail }: { providerId: string; records: CredentialRecordSummary[]; presets: CredentialPresetsView | null; accountEmail?: string }) {
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mine = records.filter((r) => r.provider === providerId);
  // The "default" credential is managed by the API-key/OAuth controls above; this
  // section is for the additional labeled accounts.
  const extra = mine.filter((r) => r.label !== "default");
  const activePreset = presets?.active ?? "";
  const mappedLabel = activePreset ? presets?.presets?.[activePreset]?.[providerId] ?? "" : "";
  const extraLabels = extra.map((r) => r.label);

  const add = async () => {
    const l = label.trim();
    const v = value.trim();
    if (!l || !v) return;
    setBusy(true);
    setErr(null);
    try {
      const isRef = v.startsWith("op://") || v.startsWith("env://") || v.startsWith("cmd://");
      await controller.setCredential(providerId, l, isRef ? { ref: v } : { key: v });
      setLabel("");
      setValue("");
      controller.listCredentialRecords();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cred-section" style={{ marginTop: 20, borderTop: "1px solid var(--border, #333)", paddingTop: 16 }}>
      <label className="field-label">Additional accounts</label>
      <p className="muted small">Add work / personal or per-project keys. Paste an API key, or a reference — <code>op://…</code>, <code>env://NAME</code>, or <code>cmd://&lt;command&gt;</code> (any password-manager CLI). References resolve on this machine; the secret never leaves your manager. <code>cmd://</code> refs stay on this machine.</p>
      {extra.length > 0 && (
        <div className="picker-list">
          {extra.map((r) => (
            <div key={r.label} className="cred-row-group" style={{ padding: "6px 0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontWeight: 600 }}>{r.label}</span>
                <span className="chip">{r.kind === "reference" ? "reference" : r.kind === "oauth" ? "OAuth" : "API key"}</span>
                {r.origin === "agent-native" && <span className="chip">from agent</span>}
                <span style={{ flex: 1 }} />
                <button
                  className="link-btn"
                  title={r.sync === "account" ? "Syncs to your other machines — tap to keep on this machine only" : "Stays on this machine — tap to sync across your machines"}
                  onClick={() => controller.setCredentialSync(providerId, r.label, r.sync === "account" ? "node" : "account")}
                >
                  {r.sync === "account" ? "Syncing" : "This machine only"}
                </button>
                <button className="link-btn danger" onClick={() => { controller.removeCredential(providerId, r.label); setTimeout(() => controller.listCredentialRecords(), 400); }}>
                  Remove
                </button>
              </div>
              <CredentialReadinessRow providerId={providerId} record={r} accountEmail={accountEmail} />
            </div>
          ))}
        </div>
      )}
      <input className="picker-search" placeholder="Label (e.g. work)" value={label} onChange={(e) => setLabel(e.target.value)} />
      <input className="picker-search" type="password" placeholder="API key, or op:// / env://NAME / cmd://…" value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="row-actions">
        <button className="btn" disabled={!label.trim() || !value.trim() || busy} onClick={add}>
          {busy ? "Adding…" : "Add account"}
        </button>
      </div>
      {err && <div className="banner error inline">{err}</div>}
      {activePreset && extraLabels.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <label className="field-label">In preset “{activePreset}”, use</label>
          <select
            className="picker-search"
            value={mappedLabel}
            onChange={(e) => controller.setPresetMapping(activePreset, providerId, e.target.value)}
          >
            <option value="">Default key</option>
            {extraLabels.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

/** One credential's redacted provider × machine × agent readiness — who it
 *  belongs to, whether it syncs across your machines, and whether it's been
 *  verified to actually work — replacing a plain "Connected" boolean. Derived
 *  by packages/core/src/credentialReadiness.ts, which never fabricates an
 *  owner or a verification result it doesn't have. */
function CredentialReadinessRow({ providerId, record, accountEmail }: { providerId: string; record: CredentialRecordSummary; accountEmail?: string }) {
  const [testing, setTesting] = useState(false);
  const [testErr, setTestErr] = useState<string | null>(null);
  const readiness = deriveCredentialReadiness(record, accountEmail);
  const verifiedLabel =
    readiness.verified === "verified" ? `Verified ${relativeTime(readiness.lastVerifiedAt)}`
    : readiness.verified === "failed" ? `Verification failed ${relativeTime(readiness.lastVerifiedAt)}`
    : "Not yet verified";
  return (
    <div className="cred-readiness" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
      <span className="muted small">{readiness.ownerLabel}</span>
      <span className="muted small" aria-hidden>·</span>
      <span className={`chip small ${readiness.verified === "verified" ? "ok" : readiness.verified === "failed" ? "warn" : ""}`}>{verifiedLabel}</span>
      {readiness.testable && (
        <button
          type="button"
          className="link-btn"
          disabled={testing}
          onClick={async () => {
            setTesting(true);
            setTestErr(null);
            try {
              const result = await controller.testCredential(providerId, record.label);
              if (!result.ok) setTestErr(testFailureReason(result.reason));
              controller.listCredentialRecords();
            } catch {
              setTestErr("Couldn't reach your machine to test this connection.");
            } finally {
              setTesting(false);
            }
          }}
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
      )}
      {testErr && <span className="muted small">{testErr}</span>}
    </div>
  );
}

function testFailureReason(reason?: string): string {
  switch (reason) {
    case "unauthorized": return "The provider rejected this credential.";
    case "refresh_failed": return "Couldn't refresh the OAuth session.";
    case "not_supported": return "This provider isn't testable yet.";
    case "not_found": return "No credential to test.";
    default: return "Couldn't reach the provider.";
  }
}

function relativeTime(at?: number): string {
  if (!at) return "";
  const deltaSec = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (deltaSec < 60) return "just now";
  const minutes = Math.round(deltaSec / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// The active-preset chooser at the top of Keys & OAuth. A preset picks which
// labeled key each provider uses; per-provider mappings are set in each
// provider's detail view (ProviderCredentials).
function PresetBar({ presets }: { presets: CredentialPresetsView | null }) {
  const [newName, setNewName] = useState("");
  const names = Object.keys(presets?.presets ?? {});
  const active = presets?.active ?? "";
  // Nothing to choose from yet and no active preset → keep the screen simple.
  if (names.length === 0 && !active) {
    return (
      <div className="preset-bar" style={{ marginBottom: 12 }}>
        <label className="field-label">Preset (optional)</label>
        <p className="muted small">Create a preset (e.g. “work”) to point providers at specific keys per project. Each provider’s default key is used until you do.</p>
        <div className="row-actions" style={{ gap: 8 }}>
          <input className="picker-search" placeholder="New preset name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="btn" disabled={!newName.trim()} onClick={() => { controller.setActivePreset(newName.trim()); setNewName(""); }}>Create</button>
        </div>
      </div>
    );
  }
  return (
    <div className="preset-bar" style={{ marginBottom: 12 }}>
      <label className="field-label">Active preset</label>
      <p className="muted small">Sessions resolve credentials against the active preset; a provider with no mapping uses its default key.</p>
      <select className="picker-search" value={active} onChange={(e) => controller.setActivePreset(e.target.value)}>
        <option value="">Default (each provider’s default key)</option>
        {names.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
      <div className="row-actions" style={{ gap: 8, marginTop: 8 }}>
        <input className="picker-search" placeholder="New preset name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button className="btn" disabled={!newName.trim()} onClick={() => { controller.setActivePreset(newName.trim()); setNewName(""); }}>Create &amp; activate</button>
      </div>
    </div>
  );
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
  // The signed-in account's own email, fetched once — used only to label an
  // account-synced credential's redacted owner (see CredentialReadinessRow).
  // Never fetched/shown in direct/self-host mode, which has no account.
  const [accountEmail, setAccountEmail] = useState<string | undefined>(undefined);
  useEffect(() => {
    controller.listProviders();
    controller.listCredentialRecords();
    controller.getCredentialPresets();
    // Pull the node list (with each node's plaintext OAuth summary) so the
    // switcher can describe every node's login state up front.
    if (hosted) void controller.refreshNodes();
    if (hosted) controller.fetchMe().then((me) => setAccountEmail(me?.account?.email)).catch(() => {});
  }, [hosted]);
  // Switching node reconnects the transport to a different daemon, so the
  // provider list open before the switch belongs to the old node — drop back to
  // the list rather than leaving a stale provider's detail on screen.
  useEffect(() => {
    setManagingId(null);
    controller.listCredentialRecords();
    controller.getCredentialPresets();
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
        {showNodePicker && <p className="muted small">On machine {nodeLabel(nodes, currentNodeId)}.</p>}
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
        {(() => {
          const defaultRecord = state.credentialRecords.find((r) => r.provider === managing.id && r.label === "default");
          return defaultRecord ? <CredentialReadinessRow providerId={managing.id} record={defaultRecord} accountEmail={accountEmail} /> : null;
        })()}
        <ProviderCredentials providerId={managing.id} records={state.credentialRecords} presets={state.credentialPresets} accountEmail={accountEmail} />
      </div>
    );
  }

  return (
    <div className="settings-form">
      <AccountApiKeys />
      {showNodePicker && (
        <>
          <p className="muted settings-intro">
            Keys &amp; OAuth are stored on each machine. Pick a machine to view and manage its sign-ins — you don't
            need an open session on it.
          </p>
          <label className="field-label">Machine</label>
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
      {!switchingTo && <PresetBar presets={state.credentialPresets} />}
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
              right={(() => {
                if (!p.configured) return undefined;
                // A record in the vault gets the honest, never-overclaiming
                // readiness label (only "Verified" once an actual test ran);
                // an env-sourced credential has no record to test, so it keeps
                // the plain "Connected" chip it always had.
                const record = state.credentialRecords.find((r) => r.provider === p.id && r.label === "default");
                const verified = record ? deriveCredentialReadiness(record, accountEmail).verified : undefined;
                if (verified === "verified") return <span className="chip ok">Verified</span>;
                if (verified === "failed") return <span className="chip warn">Verification failed</span>;
                return <span className="chip ok">Connected</span>;
              })()}
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
  hasSavedApiKey: boolean;
  models: string;
  editing: boolean;
};

const EMPTY_DRAFT: LocalModelDraft = {
  providerId: "",
  name: "",
  baseUrl: "",
  api: "openai-completions",
  apiKey: "",
  hasSavedApiKey: false,
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
    hasSavedApiKey: p.hasKey,
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
    hasSavedApiKey: false,
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
          This endpoint is account-wide, not just this machine: it syncs (encrypted) to every machine signed in to your
          account, the same way provider keys do. A <code>localhost</code> base URL only resolves on the machine
          that has it — another machine can use it only if it also runs the same server at that address locally. If
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
            ⚠ This points at the current machine. Once synced, other machines will only reach it if they
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
        <input
          className="picker-search"
          type="password"
          value={draft.apiKey}
          placeholder={draft.hasSavedApiKey ? "•••••••• (saved — leave blank to keep)" : isAzure ? "Azure OpenAI key" : "local"}
          onChange={(e) => set({ apiKey: e.target.value })}
        />
        {draft.hasSavedApiKey && !draft.apiKey && <p className="muted small">An API key is saved. Leave this blank to keep it, or enter a new key to replace it.</p>}

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
        Endpoints here sync to every machine signed in to your account, the same as provider keys — they aren't scoped
        to just this machine. A <code>localhost</code> base URL is only reachable from the machine that has it, so an
        endpoint like Ollama's default needs that same server running on each machine that should use it.
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
      : "This machine has not completed a control-plane heartbeat yet. Check that the Bivy service is running and can reach the network.";

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
          <label className="field-label" htmlFor="node-settings-node">Machine</label>
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
            {nodes.length === 0 && <option value="">No machines found</option>}
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name || n.id}{n.online ? "" : " (offline)"}
              </option>
            ))}
          </select>
          {selectedNode && <p className={`muted small${selectedNode.online ? "" : " warn-text"}`}>{selectedHealth}</p>}
          <p className="muted small">Run <code>bivy update</code> on the machine to update or repair its service, then refresh this list.</p>
        </section>
      )}

      {!nodeOnline ? (
        <p className="muted">
          {state.status === "offline"
            ? "This machine is offline — its settings aren't reachable until it reconnects."
            : "Connecting to this machine…"}
        </p>
      ) : !form ? (
        <p className="muted">Loading machine settings…</p>
      ) : (
        <>
          <section className="settings-section">
            <h4 className="settings-subhead">Identity</h4>
            <label className="field-label">Machine name</label>
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

          <details className="settings-section settings-disclosure">
            <summary className="settings-disclosure-summary">GitHub</summary>
            <div className="settings-disclosure-body">
            <label className="field-label">GitHub session limit</label>
            <input
              className="picker-search"
              type="number"
              min={0}
              value={form.githubMaxConcurrent}
              onChange={(e) => setForm({ ...form, githubMaxConcurrent: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
            />
            <p className="muted small">Maximum GitHub-triggered Runs this machine handles at once; the rest wait until a slot frees. 0 = unlimited.</p>

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
            </div>
          </details>

          <details className="settings-section settings-disclosure">
            <summary className="settings-disclosure-summary">Session resume</summary>
            <div className="settings-disclosure-body">
            <label className="field-label">After a restart interrupts a session</label>
            <div className="seg-row">
              {([
                { id: "auto", label: "Auto-resume", hint: "The agent automatically continues the interrupted turn when the machine restarts." },
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
                : "The agent picks up an interrupted turn on its own after the machine restarts."}
            </p>
            </div>
          </details>

          <details className="settings-section settings-disclosure">
            <summary className="settings-disclosure-summary">Attachments</summary>
            <div className="settings-disclosure-body">
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
            </div>
          </details>

          <details className="settings-section settings-disclosure">
            <summary className="settings-disclosure-summary">Session sync</summary>
            <div className="settings-disclosure-body">
            <div className="settings-toggle-row">
              <div className="settings-toggle-text">
                <span className="settings-toggle-title">Keep sessions synced to a standby machine</span>
                <span className="muted small">
                  Warm-replicate each session's transcript to another of your machines over the encrypted
                  relay, so a session can be picked up elsewhere if this machine goes offline. Data stays
                  machine-to-machine; the control plane never sees it.
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
                <label className="field-label">Standby machine</label>
                <select
                  className="picker-search"
                  value={form.syncStandbyNodeId ?? ""}
                  onChange={(e) => setForm({ ...form, syncStandbyNodeId: e.target.value || undefined })}
                >
                  <option value="">Choose a machine to replicate to…</option>
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
                  Sessions on this machine warm-replicate to the standby over the encrypted relay. If this
                  machine goes offline, open the session on the standby and choose “Continue here”.
                  {nodes.filter((n) => n.id !== currentNodeId).length === 0 && " Add a second machine to enable this."}
                </p>
              </>
            )}
            </div>
          </details>

          <div className="row-actions settings-save-actions">
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
        <button className="link-btn" onClick={() => { setNav(null); refreshSetups(); refreshKeys(); }}>‹ Isolated machine profiles</button>
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
        Bring your own cloud token to spin up isolated machines that self-destruct at their TTL. Each profile
        below saves its provider, region, server type, and auto-destroy time for the new-session machine
        picker. The repo it works on comes from the composer, not from here. Tap one to edit it.
      </p>
      {setups.length > 0 && (
        <>
          <label className="field-label">Isolated machine profiles</label>
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
      <label className="field-label">{setups.length > 0 ? "Add a profile" : "Choose a provider"}</label>
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
      {!controller.direct && <HostedRunnerManagement />}
    </div>
  );
}

function HostedRunnerManagement() {
  const [status, setStatus] = useState<HostedProvisioningStatus | null>(null);
  const [machines, setMachines] = useState<HostedMachineSummary[]>([]);
  const [audit, setAudit] = useState<HostedAuditEvent[]>([]);
  const [provider, setProvider] = useState("hetzner");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmDestroy, setConfirmDestroy] = useState<HostedMachineSummary | null>(null);
  const [, setClock] = useState(0);

  const refresh = async () => {
    const [nextStatus, nextMachines, nextAudit] = await Promise.all([
      controller.getHostedProvisioning(),
      controller.listHostedMachines(),
      controller.listHostedAudit(),
    ]);
    setStatus(nextStatus);
    setMachines(nextMachines);
    setAudit(nextAudit);
  };
  useEffect(() => { void refresh().catch((e) => setErr(String((e as Error)?.message || e))); }, []);
  useEffect(() => {
    const timer = setInterval(() => setClock((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, []);

  const act = async (fn: () => Promise<unknown>, success: string) => {
    if (busy) return;
    setBusy(true); setErr(null); setMsg(null);
    try { await fn(); await refresh(); setMsg(success); }
    catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setBusy(false); }
  };

  const connect = () => act(async () => {
    const value = token.trim();
    await controller.validateHostedProviderCredential(provider, value);
    await controller.setHostedProvisioning({ providerTokens: { [provider]: value } });
    setToken("");
  }, `${EPHEMERAL_PROVIDERS.find((p) => p.id === provider)?.name || provider} credential validated and stored.`);

  return (
    <section className="settings-section">
      {confirmDestroy && <ConfirmDialog
        title="Destroy hosted machine?"
        message={`Destroy ${confirmDestroy.name || confirmDestroy.nodeId || confirmDestroy.id} at ${confirmDestroy.provider} now? Active work on it will stop.`}
        confirmLabel="Destroy now"
        danger
        onCancel={() => setConfirmDestroy(null)}
        onConfirm={() => {
          const nodeId = confirmDestroy.nodeId;
          setConfirmDestroy(null);
          if (nodeId) void act(() => controller.destroyHostedMachine(nodeId), "Machine destroyed and removed from inventory.");
        }}
      />}
      <h4 className="settings-subhead">Unattended customer-cloud machines</h4>
      <p className="muted small">
        Lets Bivy launch governed automation while your devices are offline. Compute is billed directly by your provider;
        Bivy adds no compute markup. Provider credentials are encrypted on the control plane and every use is audited.
      </p>
      {status && !status.encryptionReady && <span className="chip err">Server credential encryption is not configured</span>}
      <Toggle
        checked={Boolean(status?.enabled)}
        onChange={(enabled) => void act(() => controller.setHostedProvisioning({ enabled }), enabled ? "Unattended provisioning enabled." : "New unattended launches disabled.")}
        label="Allow unattended machine launches"
      />
      <p className="muted small">Disabling stops new launches. Existing machines remain visible below until destroyed or their TTL expires.</p>

      <label className="field-label">Cloud provider</label>
      <select className="picker-search" value={provider} onChange={(e) => setProvider(e.target.value)}>
        {EPHEMERAL_PROVIDERS.map((p) => <option key={p.id} value={p.id}>
          {p.name}{p.id === "sprites" || p.id === "e2b" ? " — experimental managed compute" : " — BYO cloud"}
        </option>)}
      </select>
      {(provider === "sprites" || provider === "e2b") && <p className="muted small">
        Experimental managed-compute backend. Bivy keeps session durability portable; provider snapshots are an optimization, never the only copy.
      </p>}
      <label className="field-label">Provider credential</label>
      <input className="picker-search" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Validate before storing" />
      <button className="btn primary" disabled={busy || !token.trim() || !status?.encryptionReady} onClick={connect}>{busy ? "Working…" : "Validate and store"}</button>
      {status && status.providers.length > 0 && (
        <p className="muted small">Stored: {status.providers.map((p) => `${p}${status.validatedProviders.includes(p) ? " ✓" : " (validation required)"}`).join(", ")}</p>
      )}

      <label className="field-label">Hosted machines</label>
      {machines.length === 0 ? <p className="muted small">No hosted machines are currently tracked.</p> : <div className="picker-list">
        {machines.map((m) => {
          const providerAdapter = ephemeralAdapter(m.provider);
          const providerSize = providerAdapter?.sizes.find((size) => size.id === m.size);
          const estimate = ephemeralCostEstimate(providerSize, m.createdAt, m.ttlMinutes);
          const failure = audit.find((event) => event.nodeId === m.nodeId && (event.action === "reconcile_failed" || (event.action === "provision_failed" && /destroy|reap|teardown|settled/i.test(event.detail || ""))));
          const phase = ephemeralLifecyclePhase(m, Boolean(failure));
          const cost = estimate && providerAdapter
            ? `est. ${formatEphemeralPrice(estimate.accrued, providerAdapter.currency)} accrued / ${formatEphemeralPrice(estimate.maximum, providerAdapter.currency)} max`
            : "cost unavailable — check provider bill";
          return <PickerItem
            key={`${m.provider}:${m.id}`}
            title={<>{m.name || m.nodeId || m.id} <span className={`chip ${failure ? "err" : phase === "ready" ? "ok" : ""}`}>{phase.replaceAll("-", " ")}</span></>}
            meta={[m.provider, m.region, m.size, cost, m.ttlMinutes ? `TTL ${m.ttlMinutes}m` : null, failure?.detail].filter(Boolean).join(" · ")}
            onClick={() => document.getElementById("hosted-machine-audit")?.scrollIntoView({ behavior: "smooth" })}
            right={<button type="button" className="picker-action danger" disabled={!m.nodeId || busy} onClick={(e) => { e.stopPropagation(); setConfirmDestroy(m); }}>Destroy</button>}
          />;
        })}
      </div>}

      <label className="field-label" id="hosted-machine-audit">Recent audit evidence</label>
      {audit.some((event) => event.action === "reconcile_failed") && <span className="chip err">A machine could not be reconciled or deleted. It remains tracked for retry; check the event below and your provider console.</span>}
      {audit.length === 0 ? <p className="muted small">No hosted-machine events yet.</p> : <div className="picker-list">
        {audit.slice(0, 10).map((e, i) => <PickerItem
          key={`${e.at}:${e.action}:${i}`}
          title={e.action.replaceAll("_", " ")}
          meta={[e.provider, e.nodeId, e.detail, e.at ? new Date(e.at).toLocaleString() : null].filter(Boolean).join(" · ")}
        />)}
      </div>}
      {err && <span className="chip err">{err}</span>}
      {msg && <span className="chip ok">{msg}</span>}
    </section>
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

function AccountApiKeys() {
  const [keys, setKeys] = useState<EphemeralModelKeyInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [key, setKey] = useState("");
  const [scope, setScope] = useState<"account" | "device">("account");
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
      await controller.setEphemeralModelKey(provider, key, scope);
      setProvider("");
      setKey("");
      setMsg(scope === "account" ? "Saved to your end-to-end encrypted account vault." : "Saved on this device only.");
      refresh();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h4 className="settings-subhead">Account API keys</h4>
      <p className="muted small">
        Add model and voice API keys here even before you own a machine. Account keys synchronize end-to-end with your
        PWAs and are installed on persistent and isolated machines when they connect. The control plane stores only
        ciphertext. OAuth subscription logins still require a machine-assisted sign-in.
      </p>
      {keys.length > 0 && (
        <div className="picker-list">
          {keys.map((k) => (
            <PickerItem
              key={k.provider}
              title={k.provider}
              meta={k.configured ? (k.scope === "account" ? "Account · end-to-end encrypted" : "This device only") : "Not set"}
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
          message={`Forget the ${confirmRemove} API key from this device vault?`}
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
      <label className="field-label">Scope</label>
      <select className="picker-search" value={scope} onChange={(e) => setScope(e.target.value as "account" | "device")}>
        <option value="account">My account — E2E sync to devices and machines</option>
        <option value="device">This device only</option>
      </select>
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
              ? "Edit this isolated machine profile. It remains in the new-session launcher after a launched machine expires."
              : "Name this isolated machine profile and set its defaults. It remains in the new-session launcher after a launched machine expires."}
          </p>
          <label className="field-label">Machine name</label>
          <input className="picker-search" value={setupName} onChange={(e) => setSetupName(e.target.value)} placeholder="e.g. EU isolated machine" />

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
            <p className="muted small">Keeps its memory: suspends to ~$0 when idle and resumes with everything intact. Reopen its session from the machine list to wake it — no TTL, no teardown-on-finish.</p>
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
            <button className="btn primary" disabled={busy || !setupName.trim()} onClick={savePrefs}>{busy ? "Saving…" : setupId ? "Save profile" : "Create profile"}</button>
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
      <label className="field-label">Enrolled machines</label>
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
                    title: "Remove machine?",
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
      <p className="muted">Paste a device-link URL or code from another Bivy client to add its machine here.</p>
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
