// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SANDBOX_TIERS } from "./sandboxTiers.js";
import type { AccountMe, AppState, LocalModelEndpointResult, LocalModelPreset, LocalModelProvider, PairedDevice, NodeSettings, NotificationPreferences } from "@bivy/core";
import { NOTIFICATION_KIND_META } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { PickerItem } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { ImportSessionContent } from "./ImportSessionSheet.js";
import { MachineCapabilitiesSection } from "./MachineCapabilities.js";
import { Segmented } from "./Segmented.js";
import { Badge } from "./Badge.js";
import { AccessCard, AccessNudge } from "./AccessCard.js";
import { currentThemeSetting, machineTheme, onMachineThemeChange, setTheme, type ThemeSetting } from "../theme.js";
import { useModalBack, useModalEscape } from "../modalStack.js";
import type { SettingsView } from "../router.js";
import { clientConfiguration } from "../client-config.js";
import { accountHeader, accountOffer, planFacts, type AccountHeader as AccountHeaderView, type MeterState } from "../accountHeader.js";
import { accountExtensionFacts, accountOrigin, hasNativeSubscriptions, isPackagedClient, openAccountAction, openNativeSubscriptions, showAccountExtension } from "../packaged-client.js";
import { getAppIconBadgeEnabled, setAppIconBadgeEnabled, setNotificationPreferencesSnapshot, subscribeNotificationSettings } from "../notificationSettings.js";
import { CheckIcon, ChevronRightIcon, CloseIcon, CopyIcon } from "./UiIcons.js";
import { writeClipboard } from "../clipboard.js";
import { CredentialVault } from "./CredentialVault.js";
import { AgentInstructionsPanel } from "./AgentInstructionsPanel.js";
import { Toggle } from "./Toggle.js";
import { useMediaQuery } from "../useMediaQuery.js";

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
const IconDoc = () => (
  <Glyph><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></Glyph>
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
// The platform share glyph (box + up arrow) — the panel is about the OS share
// sheet, so the icon mirrors what users tap there.
const IconShare = () => (
  <Glyph><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" /><path d="m8 6 4-4 4 4" /><path d="M12 2v13" /></Glyph>
);

/** Render the baked-in PWA build timestamp (see __APP_BUILD_TIME__) as a short
 *  local date+time, or "" when it isn't a parseable ISO string. */
function formatBuildTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

type NavItem = { id: View; label: string; icon: ReactNode };

/** The signed-in account for the Settings account card; null until loaded (or
 *  when not hosted / the fetch fails — the card then just reads "Account"). */
function useAccountMe(hosted: boolean): AccountMe | null {
  const [me, setMe] = useState<AccountMe | null>(null);
  useEffect(() => {
    if (!hosted) return;
    let live = true;
    controller.fetchMe().then((next) => { if (live) setMe(next); }).catch(() => {});
    return () => { live = false; };
  }, [hosted]);
  return me;
}

const METER_NOTE: Record<MeterState, string | null> = { ok: null, near: "Almost used up", reached: "Limit reached" };

/** The account card's allowance meter, with the deployment's primary action
 *  (e.g. upgrade) once the allowance is nearly or fully used. */
function AccountUsage({ meter, action }: { meter: NonNullable<AccountHeaderView["meter"]>; action?: AccountHeaderView["action"] }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const note = METER_NOTE[meter.state];
  return (
    <div className="settings-account-usage" data-state={meter.state}>
      <div className="settings-account-usage-row">
        <span>{meter.label}</span>
        <span className="settings-account-usage-count">{meter.used} of {meter.limit}</span>
      </div>
      <div className="meter" role="meter" aria-label={meter.label} aria-valuemin={0} aria-valuemax={meter.limit} aria-valuenow={meter.used} aria-valuetext={`${meter.used} of ${meter.limit}${note ? ` — ${note.toLowerCase()}` : ""}`} data-state={meter.state}>
        <span className="meter-fill" style={{ width: `${(meter.used / meter.limit) * 100}%` }} />
      </div>
      {note && (
        <span className="settings-account-usage-status">
          <span className="settings-account-usage-note">{note}</span>
          {meter.freesNote && <span>{meter.freesNote}</span>}
        </span>
      )}
      {action && (
        <button
          type="button"
          className="btn primary block"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setErr(null);
            controller.invokeAccountExtensionAction(action.id)
              .then(({ url }) => openAccountAction(url))
              .catch((e) => setErr(String(e?.message || e)))
              .finally(() => setBusy(false));
          }}
        >{busy ? "Opening…" : action.label}</button>
      )}
      {err && <div className="banner inline" data-tone="danger">{err}</div>}
    </div>
  );
}

function accountInitials(email: string): string {
  const local = email.split("@")[0] ?? "";
  return (local.replace(/[^a-z0-9]/gi, "") || email).slice(0, 2).toUpperCase();
}
type NavGroup = { label: string; items: NavItem[] };

const TITLES: Record<View, string> = {
  appearance: "Appearance",
  notifications: "Notifications",
  import: "Import session",
  providers: "Models & keys",
  models: "Models & keys",
  instructions: "Agent instructions",
  voice: "Voice",
  share: "Share to Bivy",
  github: "GitHub App",
  linear: "Linear",
  slack: "Slack",
  queue: "Runs",
  webhooks: "Webhooks",
  rulesets: "Rulesets",
  nodes: "Machines",
  account: "Account",
  link: "Link a device",
};

// Search the concepts and controls inside each panel, not just its title. This
// remains intentionally compact: selecting a result opens the owning panel.
const SEARCH_TERMS: Record<View, string> = {
  appearance: "theme system light dark",
  notifications: "push alerts attention approval permission idle completed",
  import: "session transcript file upload migrate",
  providers: "model provider api key oauth openai anthropic google login credentials custom endpoint local ollama import claude codex grok machine",
  models: "model provider api key oauth ollama local custom endpoint",
  instructions: "agents.md claude.md system prompt global instructions rules preferences memory",
  voice: "microphone speech transcription read aloud reader text to speech voice tone speed",
  share: "share sheet send android ios iphone ipad shortcut link url target",
  github: "github app repository installation issue pull request",
  linear: "linear workspace issue integration",
  slack: "slack workspace channel integration",
  queue: "work queue issue run evidence outcome retry lease checks",
  webhooks: "webhook trigger secret event",
  rulesets: "rules policy routing agent runtime model sandbox",
  nodes: "node daemon online offline diagnostics version update storage disk",
  account: "account email devices machines usage",
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
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [credentialProvider, setCredentialProvider] = useState<string | null>(null);

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

  // Escape and browser Back close Settings before navigating the underlying app.
  const closeWithBack = useModalBack(onClose);
  // Focus starts inside the panel and restores to the opener on close (parity
  // with the Sheet primitive this replaced).
  const onCloseRef = useRef(closeWithBack);
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
      label: "Models & keys",
      items: [
        { id: "providers", label: "Providers & credentials", icon: <IconKey /> },
      ],
    },
    {
      label: "Agents",
      items: [
        { id: "instructions", label: "Agent instructions", icon: <IconDoc /> },
      ],
    },
    {
      label: "Machines",
      items: [
        { id: "nodes", label: "Machines", icon: <IconServer /> },
        // Pasting a link code is a fallback for adding a machine — signing in is
        // the main flow — so it sits here rather than beside the account.
        ...(hosted ? [{ id: "link" as View, label: "Link a device", icon: <IconLink /> }] : []),
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
        { id: "share", label: "Share to Bivy", icon: <IconShare /> },
      ],
    },
  ];
  // Hosted accounts get an identity card pinned to the top of the menu (the
  // Claude / ChatGPT pattern) instead of a group buried below App.
  const accountMe = useAccountMe(hosted);
  const accountEmail = accountMe?.account?.email ?? null;
  const header = accountHeader(accountMe?.extension);
  const accountItem: NavItem = { id: "account", label: accountEmail ?? "Account", icon: <IconUser /> };

  const q = query.trim().toLowerCase();
  const matches = (item: NavItem) => !q || `${item.label} ${TITLES[item.id]} ${SEARCH_TERMS[item.id]}`.toLowerCase().includes(q);
  const showAccount = hosted && matches(accountItem);
  // A query matching nothing used to hide every group and leave the sidebar
  // blank — looked broken rather than "no results" (#140).
  const hasVisibleNavItem = showAccount || groups.some((group) => group.items.some(matches));
  const navItemClass = (id: View) =>
    `settings-nav-item${activeView === id || (id === "providers" && activeView === "models") ? " active" : ""}`;

  const title = activeView ? TITLES[activeView] : "Settings";

  return createPortal(
    <div className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
      {signOutOpen && (
        <ConfirmDialog
          title="Sign out?"
          message="Sign out of Bivy on this device?"
          confirmLabel="Sign out"
          danger
          onCancel={() => setSignOutOpen(false)}
          onConfirm={() => {
            setSignOutOpen(false);
            void controller.signOut().catch((e) => controller.store.setError(String(e?.message || e)));
          }}
        />
      )}
      <div className="settings-scrim" onClick={closeWithBack} />
      <div className="settings-panel" data-mode={activeView ? "panel" : "menu"}>
        <aside className="settings-nav">
          <div className="settings-nav-top">
            <span className="settings-nav-heading">Settings</span>
            <button className="settings-x" onClick={closeWithBack} aria-label="Close settings"><CloseIcon /></button>
          </div>
          <div className="settings-search-wrap">
            <svg className="settings-search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              className="field settings-search"
              type="search"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <nav className="settings-nav-groups">
            {!hasVisibleNavItem && <div className="picker-empty">No settings match "{query.trim()}"</div>}
            {showAccount && (
              <div className="settings-account-card">
                <button className={navItemClass("account")} title={accountEmail ?? undefined} onClick={() => onViewChange("account")}>
                  <span className="settings-account-avatar" aria-hidden>{accountEmail ? accountInitials(accountEmail) : accountItem.icon}</span>
                  <span className="settings-account-text">
                    <span className="settings-nav-label">{accountItem.label}</span>
                    <span className="settings-account-sub">{header.summary ?? "Account"}</span>
                  </span>
                  <span className="settings-nav-chevron"><ChevronRightIcon size={18} /></span>
                </button>
                {header.meter && <AccountUsage meter={header.meter} action={header.action} />}
              </div>
            )}
            {groups.map((group) => {
              const visible = group.items.filter(matches);
              if (visible.length === 0) return null;
              return (
                <div className="settings-nav-group" key={group.label}>
                  <div className="settings-nav-group-label">{group.label}</div>
                  {visible.map((it) => (
                    <button
                      key={it.id}
                      className={navItemClass(it.id)}
                      onClick={() => {
                        if (it.id === "providers") setCredentialProvider(null);
                        onViewChange(it.id);
                      }}
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
          {hosted && (
            <button className="btn block" onClick={() => setSignOutOpen(true)}>
              Sign out
            </button>
          )}
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
            <button className="settings-x settings-x-content" onClick={closeWithBack} aria-label="Close settings"><CloseIcon /></button>
          </header>
          <div className="settings-body" key={activeView ?? "menu"}>
            {activeView === "appearance" && <AppearancePanel />}
            {activeView === "notifications" && <NotificationsPanel />}
            {activeView === "import" && <ImportPanel onImported={(id) => onImported?.(id)} />}
            {activeView === "share" && <SharePanel />}
            {activeView === "providers" && <CredentialVault state={state} initialProvider={credentialProvider} />}
            {/* Compatibility for old /settings/models links. New endpoints are
                added from Models & keys; this keeps the full legacy endpoint
                editor reachable without splitting the primary navigation. */}
            {activeView === "models" && <LocalModelsPanel state={state} onStartWork={onClose} />}
            {activeView === "instructions" && <AgentInstructionsPanel state={state} />}
            {activeView === "voice" && (
              <Suspense fallback={<div className="muted">Loading voice settings…</div>}>
                <VoiceSettings
                  state={state}
                  onManageKey={(providerId) => {
                    setCredentialProvider(providerId);
                    onViewChange("providers");
                  }}
                />
              </Suspense>
            )}
            {/* github / linear / slack / queue / webhooks / rulesets moved to the
                Automations hub — a deep link to any of them redirects there (see
                the redirect effect above), so they render nothing here. */}
            {activeView === "nodes" && <NodesPanel state={state} />}
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
  const [machine, setMachine] = useState(machineTheme());
  useEffect(() => onMachineThemeChange(() => setMachine(machineTheme())), []);
  const options: Array<{ id: ThemeSetting; label: string; icon: ReactNode }> = [
    ...(machine ? [{ id: "machine" as const, label: "Machine", icon: <IconAppearance /> }] : []),
    { id: "system", label: "System", icon: <IconMonitor /> },
    { id: "light", label: "Light", icon: <IconSun /> },
    { id: "dark", label: "Dark", icon: <IconMoon /> },
  ];
  return (
    <div className="settings-form">
      <label className="field-label">Theme</label>
      <Segmented
        ariaLabel="Theme"
        value={setting === "machine" && !machine ? "system" : setting}
        options={options}
        onChange={(id) => {
          setTheme(id);
          setSetting(id);
        }}
      />
      <p className="muted">
        Choose how Bivy looks. <strong>System</strong> follows your device's light/dark setting.
        {machine && <> <strong>Machine</strong> matches this machine's desktop theme, now {machine.name}, and changes with it.</>}
      </p>
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

// ---- Share to Bivy (OS share-sheet entry points — see shareTarget.ts) ----
function SharePanel() {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  // The Shortcut appends the (URL-encoded) shared text itself, so the copyable
  // piece is this origin's share URL up to the `text=` parameter.
  const shareUrl = `${accountOrigin()}/share?text=`;
  const copy = async () => {
    if (!await writeClipboard(shareUrl)) return;
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="settings-form">
      <p className="muted">Send text or a link from another app straight into a new Bivy session draft.</p>
      <section className="settings-section">
        <h4 className="settings-subhead">Android &amp; desktop</h4>
        <p className="muted">Install Bivy (Add to Home Screen / Install app) and it appears in the system share sheet automatically. Whatever you share is waiting in the composer as a new session draft.</p>
      </section>
      <section className="settings-section">
        <h4 className="settings-subhead">iPhone &amp; iPad</h4>
        <p className="muted">iOS doesn't let web apps register in its share sheet, so add a one-time Shortcut that does the same job:</p>
        <ol className="eph-steps">
          <li>Open the <strong>Shortcuts</strong> app and tap <strong>+</strong> to create a new shortcut.</li>
          <li>Add the <strong>URL Encode</strong> action — set its input to the <em>Shortcut Input</em> variable.</li>
          <li>Add the <strong>Open URLs</strong> action, paste the address below into its URL field, and place the <em>URL Encoded Text</em> variable right after <code>text=</code>.</li>
          <li>Open the shortcut's settings (ⓘ), turn on <strong>Show in Share Sheet</strong>, and name it <strong>Send to Bivy</strong>.</li>
        </ol>
        <div className="connect-command">
          <code tabIndex={0} aria-label="Share URL for the iOS Shortcut">{shareUrl}</code>
          <button type="button" className={`btn sm ghost icon-only${copied ? " is-copied" : ""}`} onClick={() => void copy()} aria-label={copied ? "Share URL copied" : "Copy share URL"} title={copied ? "Copied" : "Copy share URL"}>
            {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
          </button>
        </div>
        <p className="muted small">Sharing opens Bivy in Safari with the shared text in the composer — sign in there once if Safari and the installed app don't share a session.</p>
      </section>
    </div>
  );
}

// ---- Notifications (push on/off + per-event choices) ----
function NotificationsPanel() {
  const [status, setStatus] = useState<{ supported: boolean; subscribed: boolean; permission: string } | null>(null);
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const appIconBadgeEnabled = useSyncExternalStore(subscribeNotificationSettings, getAppIconBadgeEnabled);

  const reloadStatus = () => controller.pushStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    reloadStatus();
    controller.getNotificationPreferences().then((next) => {
      setPrefs(next);
      setNotificationPreferencesSnapshot(next);
    }).catch(() => {});
  }, []);

  // The enable/disable result (or a save error) used to sit there forever —
  // auto-dismiss it like every other transient status message in Settings (#140).
  useEffect(() => {
    if (!msg && !err) return;
    const t = setTimeout(() => { setMsg(null); setErr(null); }, 5000);
    return () => clearTimeout(t);
  }, [msg, err]);

  // Push notification controls reflect browser/server capability only.
  const on = Boolean(status?.subscribed);

  const setMaster = async (next: boolean) => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      setMsg(next ? await controller.enablePush() : await controller.disablePush());
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusy(false);
      reloadStatus();
    }
  };

  const setKind = (id: (typeof NOTIFICATION_KIND_META)[number]["id"], value: boolean) => {
    if (!prefs) return;
    const next = { ...prefs, [id]: value };
    setPrefs(next); // optimistic
    controller.setNotificationPreferences({ [id]: value }).then((saved) => {
      setPrefs(saved);
      setNotificationPreferencesSnapshot(saved);
    }).catch((e) => {
      setPrefs(prefs); // revert
      setErr(String((e as Error).message || e));
    });
  };

  // Push is delivered by a control plane; a machine reached directly has none.
  if (controller.direct) {
    return (
      <div className="settings-form">
        <AccessNudge feature="push" inSettings />
      </div>
    );
  }

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
          <span className="settings-toggle-title">Push notifications</span>
          <p className="muted">{on ? "This device receives Bivy push notifications." : "Turn on to get notified about your sessions on this device."}</p>
        </div>
        <Toggle checked={on} disabled={busy} onChange={setMaster} label="Enable push notifications" />
      </div>
      {(!isPackagedClient || typeof (navigator as Navigator & { setAppBadge?: unknown }).setAppBadge === "function") && <div className="settings-toggle-row">
        <div className="settings-toggle-text">
          <span className="settings-toggle-title">App icon badge</span>
          <p className="muted">Show the number of sessions that need attention on this device's home screen icon.</p>
        </div>
        <Toggle checked={appIconBadgeEnabled} onChange={setAppIconBadgeEnabled} label="Show app icon badge" />
      </div>}
      {status?.permission === "denied" && (
        <div className="banner inline" data-tone="warn">Notifications are blocked in your device or browser settings — allow them there to enable push.</div>
      )}
      {msg && <div className="banner inline">{msg}</div>}
      {err && <div className="banner inline" data-tone="danger" role="alert">{err}</div>}

      <label className="field-label">What to notify me about</label>
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

function LocalModelsPanel({ state, onStartWork }: { state: AppState; onStartWork: () => void }) {
  const [draft, setDraft] = useState<LocalModelDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [verification, setVerification] = useState<LocalModelEndpointResult | null>(null);
  const [discovered, setDiscovered] = useState<LocalModelEndpointResult[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryMachine, setDiscoveryMachine] = useState<string | null>(null);
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
    setVerification(null);
    setDraft(d);
  };
  const startWithModel = (provider: string, model: { id: string; name?: string }) => {
    controller.newSession();
    controller.chooseModel({ id: model.id, label: model.name || model.id, provider });
    onStartWork();
  };

  if (draft) {
    const canSave = draft.baseUrl.trim().length > 0 && !busy;
    const apiIsKnown = KNOWN_APIS.some((o) => o.value === draft.api);
    const isAzure = draft.api.toLowerCase().startsWith("azure");
    const save = async (startWork = false) => {
      setBusy(true);
      setSaveErr(null);
      try {
        // Awaits the node's real ack instead of a blind timer that closed the
        // form (looking saved) even when the node rejected it — see #140.
        const provider = await controller.saveLocalModel({
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
        const imported = parseModelLines(draft.models);
        if (startWork && imported[0]) startWithModel(provider, imported[0]);
        setDraft(null);
      } catch (e) {
        setSaveErr(String((e as Error)?.message || e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="settings-form">
        <button className="btn link" onClick={() => openDraft(null)}>‹ All endpoints</button>
        <h3>{draft.editing ? draft.name || draft.providerId : "Add endpoint"}</h3>
        <p className="muted">
          Verify an OpenAI-compatible server, then import the models it actually reports. Ollama, LM Studio, vLLM,
          SGLang, and custom endpoints are supported.
        </p>
        <p className="muted small">
          A localhost endpoint is bound to this connected Machine and will not appear as usable on another Machine.
          An explicitly entered network endpoint can be shared only where that URL is really reachable.
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

        <div className="row-actions">
          <button
            className="btn"
            disabled={!draft.baseUrl.trim() || busy}
            onClick={async () => {
              setBusy(true); setSaveErr(null); setVerification(null);
              try {
                const result = await controller.verifyLocalModel(draft.baseUrl.trim(), draft.apiKey.trim() || undefined);
                setVerification(result);
                if (result.status === "ready") {
                  const existing = parseModelLines(draft.models);
                  const merged = [...existing, ...result.models].filter((model, index, all) => all.findIndex((candidate) => candidate.id === model.id) === index);
                  set({ models: merged.map((model) => model.name && model.name !== model.id ? `${model.id} | ${model.name}` : model.id).join("\n") });
                }
              } catch (error) { setSaveErr(String((error as Error)?.message || error)); }
              finally { setBusy(false); }
            }}
          >
            {busy ? "Verifying…" : "Verify endpoint & list models"}
          </button>
        </div>
        {verification && (
          <div className="banner inline" data-tone={verification.status === "ready" ? "ok" : "danger"}>
            {verification.status === "ready"
              ? `Verified on ${verification.machineName}: ${verification.models.length} model${verification.models.length === 1 ? "" : "s"} available.`
              : `${verification.status.replace("_", " ")}: ${verification.detail || "No compatible catalog was returned."}`}
          </div>
        )}

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
          <button className="btn primary" disabled={!canSave} onClick={() => void save(false)}>
            {busy ? "Saving…" : draft.editing ? "Save changes" : "Import models"}
          </button>
          {parseModelLines(draft.models).length > 0 && (
            <button className="btn" disabled={!canSave} onClick={() => void save(true)}>Import & use in new session</button>
          )}
          <button className="btn" onClick={() => openDraft(null)}>Cancel</button>
        </div>
        {saveErr && <div className="banner inline" data-tone="danger">{saveErr}</div>}
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

      <h3>Model endpoints</h3>
      <p className="muted">
        Connect OpenAI-compatible servers (Ollama, LM Studio, vLLM, SGLang, Azure…) and import the models
        they report. Localhost endpoints stay tied to the Machine that hosts them.
      </p>

      {/* Primary: the endpoints you've configured. */}
      {state.settings.localModels.length === 0 ? (
        <div className="vault-empty">
          <h4>No endpoints yet</h4>
          <p className="muted">Add an OpenAI-compatible server, or discover one running on this Machine below.</p>
          <button className="btn primary" onClick={() => openDraft({ ...EMPTY_DRAFT })}>Add endpoint</button>
        </div>
      ) : (
        <>
          <div className="picker-list vault-items">
            {state.settings.localModels.map((p) => (
              <PickerItem
                key={p.id}
                title={p.name || p.id}
                meta={`${p.baseUrl} · ${p.modelCount} model${p.modelCount === 1 ? "" : "s"}${p.hasKey ? " · key" : ""} · ${p.scope === "machine" ? `hosted by ${p.machineName || "one Machine"}` : "network endpoint"}${p.availableOnThisMachine ? "" : " · unavailable on this Machine"}`}
                right={
                  <div className="row-actions">
                    {p.availableOnThisMachine && p.models[0] && (
                      <button className="btn sm" onClick={(e) => { e.stopPropagation(); startWithModel(p.id, p.models[0]!); }}>
                        Use
                      </button>
                    )}
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
                  </div>
                }
                onClick={() => openDraft(draftFromProvider(p))}
              />
            ))}
          </div>
          <button className="btn primary block" onClick={() => openDraft({ ...EMPTY_DRAFT })}>+ Add endpoint</button>
        </>
      )}

      {/* Secondary: find or quick-add endpoints, clearly separated from your list. */}
      <div className="settings-section">
        <h4 className="settings-subhead">Find models on this Machine</h4>
        <p className="muted small">
          Discover checks a short, fixed list of common localhost ports on the connected Machine
          only — it never scans your LAN. Localhost models stay tied to the Machine that hosts them.
        </p>
        <button
          className="btn block"
          disabled={discovering}
          onClick={async () => {
            setDiscovering(true); setDiscoveryError(null);
            try {
              const result = await controller.discoverLocalModels();
              setDiscovered(result.endpoints);
              setDiscoveryMachine(result.machineName);
            } catch (error) { setDiscoveryError(String((error as Error)?.message || error)); }
            finally { setDiscovering(false); }
          }}
        >
          {discovering ? "Discovering on this Machine…" : "Discover on this Machine"}
        </button>
        {discoveryMachine && <p className="muted small">Results from <strong>{discoveryMachine}</strong>. They do not describe other Machines.</p>}
        {discoveryError && <div className="banner inline" data-tone="danger">{discoveryError}</div>}
        {discovered && (
          <div className="picker-list">
            {discovered.map((endpoint) => (
              <PickerItem
                key={endpoint.candidateId || endpoint.baseUrl}
                title={endpoint.name || endpoint.baseUrl}
                meta={endpoint.status === "ready"
                  ? `${endpoint.models.length} model${endpoint.models.length === 1 ? "" : "s"} available on ${endpoint.machineName}`
                  : `${endpoint.status.replace("_", " ")} · ${endpoint.detail || "No compatible response"}`}
                right={endpoint.status === "ready" ? <Badge tone="ok">Import</Badge> : endpoint.status === "auth_required" ? <Badge tone="warn">Add key</Badge> : <Badge tone="warn">{endpoint.status.replace("_", " ")}</Badge>}
                onClick={endpoint.status === "ready" || endpoint.status === "auth_required" ? () => openDraft({
                  ...draftFromPreset({ id: endpoint.candidateId || "local", name: endpoint.name || "Local models", baseUrl: endpoint.baseUrl, api: endpoint.api }),
                  models: endpoint.models.map((model) => model.name !== model.id ? `${model.id} | ${model.name}` : model.id).join("\n"),
                }) : undefined}
              />
            ))}
          </div>
        )}
        {state.settings.localModelPresets.length > 0 && (
          <>
            <h4 className="settings-subhead">Quick add</h4>
            <div className="row-actions" style={{ flexWrap: "wrap" }}>
              {state.settings.localModelPresets.map((preset) => (
                <button key={preset.id} className="btn" title={preset.note} onClick={() => openDraft(draftFromPreset(preset))}>
                  {preset.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
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
  const [nodeClaim, setNodeClaim] = useState<Awaited<ReturnType<typeof controller.createNodeClaim>> | null>(null);
  const [nodeClaims, setNodeClaims] = useState<Awaited<ReturnType<typeof controller.listNodeClaims>>>([]);
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimCopied, setClaimCopied] = useState(false);
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
  useEffect(() => {
    if (!hosted) return;
    const refreshClaims = () => controller.listNodeClaims().then((claims) => {
      setNodeClaims(claims);
      if (nodeClaim && claims.find((claim) => claim.id === nodeClaim.id)?.status !== "pending") setNodeClaim(null);
    }).catch(() => {});
    void refreshClaims();
    if (!nodeClaim) return;
    const timer = window.setInterval(refreshClaims, 3000);
    return () => window.clearInterval(timer);
  }, [hosted, nodeClaim]);

  // The node whose settings we're editing is only ever the one the transport
  // is actually connected to (`state.connection.status === "online"`) — never a guess
  // based on a fixed timeout. While it's offline/connecting, don't trust
  // whatever is left in `state.settings.nodeSettings` (a prior node's data, or none).
  const nodeOnline = state.connection.status === "online";
  useEffect(() => {
    if (hosted && nodeOnline) controller.getNodeSettings();
  }, [hosted, nodeOnline, currentNodeId]);

  // Re-seed the editable form whenever fresh settings arrive from the node
  // (initial load, or after switching to a different node). Keyed on the node
  // name so an in-progress edit isn't clobbered by an unrelated re-render.
  const settings = nodeOnline ? state.settings.nodeSettings : null;
  // Includes githubIssuePrompt so `resetIssuePrompt` (which doesn't touch the
  // rest of the form) re-seeds once the node echoes back the restored default.
  const sig = settings ? `${settings.name}|${settings.defaultAgent}|${settings.githubIssuePrompt}` : "";
  // Intentionally keyed on `sig`, not `settings`: re-seed the form only when the
  // signature changes (a real node/settings switch), so a new `settings` object
  // identity from an unrelated re-render doesn't clobber an in-progress edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setForm(settings); }, [sig]);

  const runtimes = state.catalogs.runtimes.filter((r) => String((r as { status?: string }).status ?? "available") === "available");
  const agentCaps = state.catalogs.runtimes.find((r) => r.id === form?.defaultAgent)?.capabilities as { modelSelection?: boolean } | undefined;
  const modelSelectable = agentCaps?.modelSelection !== false;
  const models = state.catalogs.models;

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
        appScreenshots: form.appScreenshots === true,
      });
      setSavedMsg("Saved");
      setTimeout(() => setSavedMsg(null), 1500);
    } catch (e) {
      setSaveErr(String((e as Error)?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const recentNodeClaims = nodeClaims.filter((claim) => claim.id !== nodeClaim?.id).slice(0, 5);

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
      {saveErr && <div className="banner inline" data-tone="danger" role="alert">{saveErr}</div>}
      {nodeOnline && <AccessCard key={currentNodeId || "direct"} />}
      {hosted && (
        <section className="settings-section">
          <h4 className="settings-subhead">Connect a machine</h4>
          <p className="muted small">Create a one-time command, then run it on a macOS or Linux machine. It expires after 10 minutes and can enroll only one machine.</p>
          {!nodeClaim?.command ? (
            <button
              type="button"
              className="btn primary"
              disabled={claimBusy}
              onClick={() => {
                setClaimBusy(true);
                setSaveErr(null);
                controller.createNodeClaim()
                  .then((claim) => {
                    setNodeClaim(claim);
                    setNodeClaims((current) => [claim, ...current.filter((item) => item.id !== claim.id)]);
                  })
                  .catch((error) => setSaveErr(String((error as Error)?.message || error)))
                  .finally(() => setClaimBusy(false));
              }}
            >{claimBusy ? "Creating…" : "Create install command"}</button>
          ) : (
            <>
              <div className="repo-connect-command">
                <code>{nodeClaim.command}</code>
                <button
                  type="button"
                  className={`btn sm ghost${claimCopied ? " is-copied" : ""}`}
                  onClick={() => {
                    void navigator.clipboard.writeText(nodeClaim.command || "").then(() => {
                      setClaimCopied(true);
                      window.setTimeout(() => setClaimCopied(false), 1500);
                    });
                  }}
                >{claimCopied ? "Copied" : "Copy"}</button>
              </div>
              <div className="card-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setClaimBusy(true);
                    controller.revokeNodeClaim(nodeClaim.id)
                      .then(() => {
                        setNodeClaim(null);
                        return controller.listNodeClaims().then(setNodeClaims);
                      })
                      .catch((error) => setSaveErr(String((error as Error)?.message || error)))
                      .finally(() => setClaimBusy(false));
                  }}
                  disabled={claimBusy}
                >Revoke</button>
              </div>
            </>
          )}
          {recentNodeClaims.length > 0 && (
            <div className="picker-list">
              {recentNodeClaims.map((claim) => (
                <PickerItem
                  key={claim.id}
                  title={`Install command · ${claim.status}`}
                  meta={claim.nodeId ? `Used by ${claim.nodeId}` : `Expires ${new Date(claim.expiresAt).toLocaleTimeString()}`}
                  right={claim.status === "pending" ? (
                    <button
                      type="button"
                      className="btn sm danger-ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        controller.revokeNodeClaim(claim.id)
                          .then(() => controller.listNodeClaims().then(setNodeClaims))
                          .catch((error) => setSaveErr(String((error as Error)?.message || error)));
                      }}
                    >Revoke</button>
                  ) : undefined}
                />
              ))}
            </div>
          )}
        </section>
      )}
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

      <MachineCapabilitiesSection online={nodeOnline} />

      {!nodeOnline ? (
        <p className="muted">
          {state.connection.status === "offline"
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
                  className="selectable"
                  aria-pressed={form.defaultSandbox === t.id}
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
                  className="selectable"
                  aria-pressed={form.sessionResumeMode === o.id}
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
            <summary className="settings-disclosure-summary">App previews</summary>
            <div className="settings-disclosure-body">
            <div className="settings-toggle-row">
              <div className="settings-toggle-text">
                <span className="settings-toggle-title">Let agents screenshot their app previews</span>
                <span className="muted small">
                  Agents can run <code>bivy app shot</code> to see their previews at phone and desktop widths, in light
                  and dark, before they say they’re done. It uses Chrome or Chromium on this machine and a few hundred
                  MB of memory while it runs. Also used for before/after comparisons in previews.
                </span>
              </div>
              <Toggle
                checked={form.appScreenshots === true}
                onChange={(v) => setForm({ ...form, appScreenshots: v })}
                label="Let agents screenshot their app previews"
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
            {savedMsg && <Badge tone="ok">{savedMsg}</Badge>}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Account ----
function AccountPanel() {
  const [me, setMe] = useState<AccountMe | null>(null);
  const [nodes, setNodes] = useState<Awaited<ReturnType<typeof controller.listNodes>>>([]);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [accountAction, setAccountAction] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; label?: string; action: () => void }>(null);
  const reloadMe = () => controller.fetchMe().then(setMe).catch(() => {});
  const reloadDevices = () => controller.listDevices().then(setDevices).catch(() => {});
  useEffect(() => {
    controller.fetchMe().then(setMe).catch((e) => setErr(String(e.message || e)));
    controller.listNodes().then(setNodes).catch(() => {});
    reloadDevices();
  }, []);
  const planRows = planFacts(accountExtensionFacts(me?.extension?.facts), me?.extension);
  const usage = accountHeader(me?.extension);
  const offer = accountOffer(me?.extension);
  const otherActions = (showAccountExtension() ? me?.extension?.actions ?? [] : []).filter((a) => a.id !== offer?.action.id);
  const runAction = (id: string) => {
    setAccountAction(id);
    controller.invokeAccountExtensionAction(id)
      .then(({ url }) => openAccountAction(url))
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setAccountAction(null));
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
      {err && <div className="banner inline" data-tone="danger">{err}</div>}
      {me?.account?.email && (
        <div className="settings-toggle-row">
          <span className="muted">Signed in as</span>
          <strong>{me.account.email}</strong>
        </div>
      )}
      {hasNativeSubscriptions() && (
        <div className="settings-section">
          <h4 className="settings-subhead">Subscriptions</h4>
          <button type="button" className="btn" disabled={accountAction !== null} onClick={() => {
            setAccountAction("native-subscriptions");
            openNativeSubscriptions(controller.local.s)
              .then(reloadMe)
              .catch(() => setErr("Could not open subscriptions. Please try again."))
              .finally(() => setAccountAction(null));
          }}>{accountAction === "native-subscriptions" ? "Opening…" : "Manage subscriptions"}</button>
          <p className="muted">Purchases and restores are handled by your app store.</p>
        </div>
      )}
      {me?.extension && (planRows.length > 0 || usage.meter || otherActions.length > 0) && (
        <div className="settings-section">
          <h4 className="settings-subhead">{me.extension.title || "Account service"}</h4>
          {/* The extension's facts are opaque label/value pairs — render them
              through the standard settings row (label left, value right, hairline
              separators) rather than a bespoke layout. */}
          <div>
            {planRows.map((fact) => (
              <div className="settings-toggle-row" key={fact.id}>
                <span className="muted">{fact.label}</span>
                <strong>{fact.value}</strong>
              </div>
            ))}
          </div>
          {/* The same allowance meter as the Settings account card. */}
          {usage.meter && <AccountUsage meter={usage.meter} />}
          {otherActions.length > 0 && <div className="card-actions">
            {otherActions.map((action) => (
              <button
                type="button"
                key={action.id}
                className={`btn ${action.kind === "primary" ? "primary" : ""}`}
                disabled={accountAction !== null}
                onClick={() => runAction(action.id)}
              >{accountAction === action.id ? "Opening…" : action.label}</button>
            ))}
          </div>}
        </div>
      )}
      {offer && (
        <section className="card account-offer" data-tone="accent" aria-labelledby="account-offer-title">
          <div className="card-head">
            <span className="card-title" id="account-offer-title">{offer.title}</span>
            {offer.price && <span className="account-offer-price">{offer.price}</span>}
          </div>
          {offer.description && <p className="card-sub">{offer.description}</p>}
          {offer.points.length > 0 && (
            <ul className="account-offer-points">
              {offer.points.map((point) => (
                <li key={point}><span className="account-offer-check" aria-hidden><CheckIcon size={16} /></span>{point}</li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="btn primary block"
            disabled={accountAction !== null}
            onClick={() => runAction(offer.action.id)}
          >{accountAction === offer.action.id ? "Opening…" : offer.action.label}</button>
        </section>
      )}
      <div className="settings-section">
        <h4 className="settings-subhead">Enrolled machines{nodes.length > 0 && <span className="muted"> · {nodes.length}</span>}</h4>
        <div className="picker-list">
          {nodes.length === 0 && <div className="picker-empty">No machines enrolled yet.</div>}
          {nodes.map((n) => (
            <PickerItem
              key={n.id}
              active={n.id === controller.local.cur}
              title={n.name || n.id}
              meta={n.online ? "Online" : "Offline"}
              right={
                <button
                  type="button"
                  className="btn sm danger-ghost"
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
      </div>

      <div className="settings-section">
        <h4 className="settings-subhead">Signed-in devices{devices.length > 0 && <span className="muted"> · {devices.length}</span>}</h4>
        <div className="picker-list">
          {devices.length === 0 && <div className="picker-empty">No paired devices.</div>}
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
                    className="btn sm danger-ghost"
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
      </div>

      <div className="settings-section">
        <button
          className="btn danger-ghost block"
          disabled={accountAction !== null}
          onClick={() => setConfirm({
            title: "Delete account?",
            message: clientConfiguration.accountDeletionMessage ?? "This permanently deletes your Bivy account and its data. This cannot be undone.",
            label: "Delete account",
            action: () => {
              setAccountAction("delete-account");
              controller.deleteAccount()
                .then(() => controller.signOut())
                .catch((e) => setErr(String(e?.message || e)))
                .finally(() => setAccountAction(null));
            },
          })}
        >
          {accountAction === "delete-account" ? "Deleting…" : "Delete account"}
        </button>
      </div>
    </div>
  );
}

function formatDeviceDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "recently";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
      {err && <div className="banner inline" data-tone="danger">{err}</div>}
    </div>
  );
}
