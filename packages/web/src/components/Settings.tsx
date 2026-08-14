// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AccountMe, AppState, EphemeralNodeConfig, LocalModelEndpointResult, LocalModelPreset, LocalModelProvider, PairedDevice, NodeSettings, NotificationPreferences, SandboxTier, EphemeralMachine, ProviderKeyInfo, ProviderSize, HostedAuditEvent, HostedMachineSummary, HostedProvisioningStatus } from "@bivy/core";
import { NOTIFICATION_KIND_META, EPHEMERAL_PROVIDERS, ephemeralAdapter, ephemeralCostHint, ephemeralCostEstimate, ephemeralLifecyclePhase, formatEphemeralPrice } from "@bivy/core";
import { controller } from "../store/useStore.js";
import { PickerItem } from "./Sheet.js";
import { ConfirmDialog } from "./AppDialog.js";
import { ImportSessionContent } from "./ImportSessionSheet.js";
import { MachineCapabilitiesSection } from "./MachineCapabilities.js";
import { Segmented } from "./Segmented.js";
import { currentThemeSetting, setTheme, type ThemeSetting } from "../theme.js";
import { useModalEscape } from "../modalStack.js";
import type { SettingsView } from "../router.js";
import { EPHEMERAL_MACHINES_ENABLED } from "../flags.js";
import { ChevronRightIcon, CloseIcon } from "./UiIcons.js";
import { CredentialVault } from "./CredentialVault.js";

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
  providers: "Models & keys",
  models: "Models & keys",
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
  providers: "model provider api key oauth openai anthropic google login credentials custom endpoint local ollama",
  models: "model provider api key oauth ollama local custom endpoint",
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
      label: "Models & keys",
      items: [
        { id: "providers", label: "Providers & credentials", icon: <IconKey /> },
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
                      className={`settings-nav-item${activeView === it.id || (it.id === "providers" && activeView === "models") ? " active" : ""}`}
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
            {activeView === "providers" && <CredentialVault state={state} />}
            {/* Compatibility for old /settings/models links. New endpoints are
                added from Models & keys; this keeps the full legacy endpoint
                editor reachable without splitting the primary navigation. */}
            {activeView === "models" && <LocalModelsPanel state={state} onStartWork={onClose} />}
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
      <Segmented
        ariaLabel="Theme"
        value={setting}
        options={options}
        onChange={(id) => {
          setTheme(id);
          setSetting(id);
        }}
      />
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
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadStatus = () => controller.pushStatus().then(setStatus).catch(() => {});
  useEffect(() => {
    reloadStatus();
    controller.getNotificationPreferences().then(setPrefs).catch(() => {});
  }, []);

  // The enable/disable result (or a save error) used to sit there forever —
  // auto-dismiss it like every other transient status message in Settings (#140).
  useEffect(() => {
    if (!msg && !err) return;
    const t = setTimeout(() => { setMsg(null); setErr(null); }, 5000);
    return () => clearTimeout(t);
  }, [msg, err]);

  // Push notifications are included on every plan, so there's no upgrade gate.
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
    controller.setNotificationPreferences({ [id]: value }).then(setPrefs).catch((e) => {
      setPrefs(prefs); // revert
      setErr(String((e as Error).message || e));
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
          <span className="settings-toggle-title">Push notifications</span>
          <p className="muted">{on ? "This device receives Bivy push notifications." : "Turn on to get notified about your sessions on this device."}</p>
        </div>
        <Toggle checked={on} disabled={busy} onChange={setMaster} label="Enable push notifications" />
      </div>
      {status?.permission === "denied" && (
        <div className="banner warn inline">Notifications are blocked in your browser settings — allow them there to enable push.</div>
      )}
      {msg && <div className="banner inline">{msg}</div>}
      {err && <div className="banner error inline" role="alert">{err}</div>}

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
        <button className="link-btn" onClick={() => openDraft(null)}>‹ All endpoints</button>
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
          <div className={`banner inline ${verification.status === "ready" ? "success" : "error"}`}>
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
        {discoveryError && <div className="banner error inline">{discoveryError}</div>}
        {discovered && (
          <div className="picker-list">
            {discovered.map((endpoint) => (
              <PickerItem
                key={endpoint.candidateId || endpoint.baseUrl}
                title={endpoint.name || endpoint.baseUrl}
                meta={endpoint.status === "ready"
                  ? `${endpoint.models.length} model${endpoint.models.length === 1 ? "" : "s"} available on ${endpoint.machineName}`
                  : `${endpoint.status.replace("_", " ")} · ${endpoint.detail || "No compatible response"}`}
                right={endpoint.status === "ready" ? <span className="chip ok">Import</span> : endpoint.status === "auth_required" ? <span className="chip warn">Add key</span> : <span className="chip warn">{endpoint.status.replace("_", " ")}</span>}
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

// One-line, humanized lifecycle for a saved profile — used in list subtitles and
// the editor's summary card so the same wording appears everywhere.
function ephemeralLifecycleLabel(setup: EphemeralNodeConfig): string {
  if (ephemeralAdapter(setup.provider)?.suspendsWhenIdle) return "suspends to ~$0 when idle";
  if (setup.teardownOnAgentFinish) return "runs until the agent finishes";
  if (setup.ttlMinutes) return `destroys ${setup.ttlMinutes} min after launch`;
  return "provider-default lifetime";
}
// The scannable subtitle for a profile row: provider · region · size · lifecycle.
function ephemeralProfileMeta(setup: EphemeralNodeConfig): string {
  const provider = EPHEMERAL_PROVIDERS.find((x) => x.id === setup.provider);
  return [provider?.name, setup.region, setup.size, ephemeralLifecycleLabel(setup)].filter(Boolean).join(" · ");
}

// The panel is a shallow view machine (like the credential vault): profiles are
// the whole list; adding, editing, and the separate hosted concern are their own
// focused screens, so nothing is a wall of stacked sections.
type EphemeralView =
  | { k: "list" }
  | { k: "add" }
  | { k: "hosted" }
  | { k: "editor"; provider: string; setupId: string | null };

function EphemeralPanel() {
  const [keys, setKeys] = useState<ProviderKeyInfo[]>([]);
  const [setups, setSetups] = useState<EphemeralNodeConfig[]>([]);
  const [view, setView] = useState<EphemeralView>({ k: "list" });
  const refreshKeys = () => controller.listEphemeralKeys().then(setKeys).catch(() => {});
  // Account-level ephemeral configs — the same records the new-session node
  // picker lists, so a machine saved here shows up there (and syncs across the
  // account's devices). The provider token stays device-local.
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
      const have = new Set(configs.map((c) => `${c.provider} ${c.name}`));
      for (const s of legacy) {
        if (!have.has(`${s.provider} ${s.name}`)) {
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

  const backToList = () => { setView({ k: "list" }); refreshSetups(); refreshKeys(); };

  if (view.k === "add") {
    return (
      <EphemeralProviderChooser
        keys={keys}
        onBack={() => setView({ k: "list" })}
        onPick={(provider) => setView({ k: "editor", provider, setupId: null })}
      />
    );
  }

  if (view.k === "hosted") {
    return (
      <div className="settings-form machine-profiles">
        <button className="link-btn" onClick={() => setView({ k: "list" })}>‹ Isolated machine profiles</button>
        <HostedRunnerManagement />
      </div>
    );
  }

  if (view.k === "editor") {
    const catalog = EPHEMERAL_PROVIDERS.find((p) => p.id === view.provider);
    if (catalog) {
      return (
        <div className="settings-form machine-profiles">
          <button className="link-btn" onClick={backToList}>‹ Isolated machine profiles</button>
          <EphemeralProviderConfig
            providerId={catalog.id}
            initialSetupId={view.setupId}
            onKeysChanged={refreshKeys}
            onSetupsChanged={refreshSetups}
            onBack={backToList}
          />
        </div>
      );
    }
  }

  // List view — profiles are the whole panel; sync + hosted drill in below.
  return (
    <div className="settings-form machine-profiles">
      <div className="vault-title-row">
        <div><h3>Isolated machine profiles</h3></div>
        <button className="btn primary" onClick={() => setView({ k: "add" })}>Add profile</button>
      </div>
      <p className="muted">
        Reusable setups for temporary cloud servers in your own account. Compute is billed by your
        provider — Bivy adds no markup.
      </p>

      {setups.length === 0 ? (
        <div className="vault-empty">
          <h4>No profiles yet</h4>
          <p className="muted">Connect a cloud provider once, then save reusable setups for temporary servers you own.</p>
          <button className="btn primary" onClick={() => setView({ k: "add" })}>Connect a provider</button>
        </div>
      ) : (
        <div className="picker-list vault-items">
          {setups.map((setup) => (
            <PickerItem
              key={setup.id}
              title={setup.name}
              meta={ephemeralProfileMeta(setup)}
              right={<span className="picker-meta" aria-hidden>›</span>}
              onClick={() => setView({ k: "editor", provider: setup.provider, setupId: setup.id })}
            />
          ))}
        </div>
      )}

      <div className="settings-toggle-row">
        <div className="settings-toggle-text">
          <div className="settings-toggle-title">Cross-device token sync</div>
          <p className="muted small">End-to-end encrypted, opt-in — your other signed-in devices can reach machines you launch here without re-entering the token.</p>
        </div>
        <EphemeralTokenSyncToggle />
      </div>

      {!controller.direct && (
        <div className="picker-list">
          <PickerItem
            title="Unattended machines"
            meta="Hosted — let Bivy run governed automation while your devices are offline"
            right={<span className="picker-meta" aria-hidden>›</span>}
            onClick={() => setView({ k: "hosted" })}
          />
        </div>
      )}
    </div>
  );
}

// Add flow: pick where to run. The recommended provider is a highlighted card;
// the rest are a plain list, each showing whether its token is already saved.
function EphemeralProviderChooser({ keys, onBack, onPick }: { keys: ProviderKeyInfo[]; onBack: () => void; onPick: (provider: string) => void }) {
  const recommended = EPHEMERAL_PROVIDERS.find((p) => p.id === "fly" && p.maturity === "stable")
    ?? EPHEMERAL_PROVIDERS.find((p) => p.maturity === "stable");
  const others = EPHEMERAL_PROVIDERS.filter((p) => p.id !== recommended?.id);
  const statusChip = (id: string, maturity: string, hostedOnly?: boolean) => {
    if (keys.find((x) => x.id === id)?.configured) return <span className="chip ok">Token saved</span>;
    if (hostedOnly) return <span className="chip warn">Hosted only</span>;
    if (maturity === "experimental") return <span className="chip warn">Experimental</span>;
    return <span className="chip">Not set up</span>;
  };
  return (
    <div className="settings-form machine-profiles">
      <button className="link-btn" onClick={onBack}>‹ Isolated machine profiles</button>
      <h3>Add a profile</h3>
      <p className="muted">Choose where to run. You paste a token once per provider, then save as many profiles as you like.</p>
      {recommended && (
        <button type="button" className="custom-provider-card" onClick={() => onPick(recommended.id)}>
          <span className="custom-provider-card-icon" aria-hidden>✦</span>
          <span><strong>{recommended.name} · Recommended</strong><small>{recommended.blurb}</small></span>
          {keys.find((x) => x.id === recommended.id)?.configured
            ? <span className="chip ok">Token saved</span>
            : <span className="picker-meta" aria-hidden>›</span>}
        </button>
      )}
      <p className="vault-picker-label">Other providers</p>
      <div className="picker-list">
        {others.map((p) => (
          <PickerItem
            key={p.id}
            title={p.name}
            meta={p.blurb}
            right={statusChip(p.id, p.maturity, p.hostedOnly)}
            onClick={() => onPick(p.id)}
          />
        ))}
      </div>
    </div>
  );
}

// Opt-in: sync provider tokens to the account's OTHER devices via an E2E device
// vault (off by default; the control plane only ever stores ciphertext).
function EphemeralTokenSyncToggle() {
  const [on, setOn] = useState(false);
  useEffect(() => { setOn(controller.getDeviceTokenSync()); }, []);
  return (
    <Toggle
      checked={on}
      onChange={(v) => { controller.setDeviceTokenSync(v); setOn(v); }}
      label="Sync provider tokens across my devices"
    />
  );
}

// Unattended / hosted machines — its own drill-in sub-view so it never competes
// with the primary "profiles" purpose. Control-plane-launched machines that run
// while your devices are offline, with credential validation + an audit log.
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
    <div className="settings-form">
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
      <div>
        <h3>Unattended machines</h3>
        <p className="muted">Let Bivy launch governed machines while your devices are offline. Compute is billed directly by your provider; Bivy adds no markup. Credentials are encrypted on the control plane and every use is audited.</p>
      </div>

      {status && !status.encryptionReady && <div className="banner error inline" role="alert">Server credential encryption isn't configured, so unattended machines can't be enabled yet.</div>}

      <div className="settings-toggle-row">
        <div className="settings-toggle-text">
          <div className="settings-toggle-title">Allow unattended launches</div>
          <p className="muted small">Disabling stops new launches; existing machines stay listed until destroyed or their TTL expires.</p>
        </div>
        <Toggle
          checked={Boolean(status?.enabled)}
          disabled={!status?.encryptionReady}
          onChange={(enabled) => void act(() => controller.setHostedProvisioning({ enabled }), enabled ? "Unattended provisioning enabled." : "New unattended launches disabled.")}
          label="Allow unattended machine launches"
        />
      </div>

      <label className="field-label">Provider credential</label>
      <select className="picker-search" value={provider} onChange={(e) => setProvider(e.target.value)}>
        {EPHEMERAL_PROVIDERS.map((p) => <option key={p.id} value={p.id}>
          {p.name}{p.id === "sprites" || p.id === "e2b" ? " — experimental managed compute" : " — bring your own cloud"}
        </option>)}
      </select>
      {(provider === "sprites" || provider === "e2b") && <p className="muted small">Experimental managed-compute backend. Session durability stays portable; provider snapshots are an optimization, never the only copy.</p>}
      <input className="picker-search" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste credential to validate and store" />
      <div className="row-actions">
        <button className="btn primary" disabled={busy || !token.trim() || !status?.encryptionReady} onClick={connect}>{busy ? "Working…" : "Validate and store"}</button>
      </div>
      {status && status.providers.length > 0 && (
        <p className="muted small">Stored: {status.providers.map((p) => `${p}${status.validatedProviders.includes(p) ? " ✓" : " (validation required)"}`).join(", ")}</p>
      )}

      <details className="vault-advanced" open>
        <summary>Machines ({machines.length})</summary>
        {machines.length === 0 ? <p className="muted small">No hosted machines are currently tracked.</p> : <div className="picker-list">
          {machines.map((m) => {
            const providerAdapter = ephemeralAdapter(m.provider);
            const providerSize = providerAdapter?.sizes.find((size) => size.id === m.size);
            const estimate = ephemeralCostEstimate(providerSize, m.createdAt, m.ttlMinutes);
            const failure = audit.find((event) => event.nodeId === m.nodeId && (event.action === "reconcile_failed" || (event.action === "provision_failed" && /destroy|reap|teardown|settled/i.test(event.detail || ""))));
            const phase = ephemeralLifecyclePhase(m, Boolean(failure));
            const cost = estimate && providerAdapter
              ? `${formatEphemeralPrice(estimate.accrued, providerAdapter.currency)} accrued`
              : "cost via provider bill";
            return <PickerItem
              key={`${m.provider}:${m.id}`}
              title={<>{m.name || m.nodeId || m.id} <span className={`chip ${failure ? "err" : phase === "ready" ? "ok" : ""}`}>{phase.replaceAll("-", " ")}</span></>}
              meta={[m.provider, m.region, m.size, cost, m.ttlMinutes ? `TTL ${m.ttlMinutes}m` : null].filter(Boolean).join(" · ")}
              right={<button type="button" className="picker-action danger" disabled={!m.nodeId || busy} onClick={(e) => { e.stopPropagation(); setConfirmDestroy(m); }}>Destroy</button>}
            />;
          })}
        </div>}
      </details>

      <details className="vault-advanced">
        <summary>Audit log</summary>
        {audit.some((event) => event.action === "reconcile_failed") && <div className="banner error inline" role="alert">A machine couldn't be reconciled or deleted. It stays tracked for retry — check the events below and your provider console.</div>}
        {audit.length === 0 ? <p className="muted small">No hosted-machine events yet.</p> : <div className="picker-list">
          {audit.slice(0, 10).map((e, i) => <PickerItem
            key={`${e.at}:${e.action}:${i}`}
            title={e.action.replaceAll("_", " ")}
            meta={[e.provider, e.nodeId, e.detail, e.at ? new Date(e.at).toLocaleString() : null].filter(Boolean).join(" · ")}
          />)}
        </div>}
      </details>

      {err && <div className="banner error inline" role="alert">{err}</div>}
      {msg && <div className="banner inline">{msg}</div>}
    </div>
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
  const [setupId, setSetupId] = useState<string | null>(null);
  const [setupName, setSetupName] = useState("");
  const [machines, setMachines] = useState<EphemeralMachine[]>([]);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
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

  const selectedSize = sizes.find((s) => s.id === size);
  const costHint = ephemeralCostHint(selectedSize, suspendsWhenIdle ? undefined : ttl, adapter.currency);
  const lifecycleSummary = suspendsWhenIdle
    ? "Suspends to ~$0 when idle; wake it from the machine list"
    : teardownOnAgentFinish
      ? `Destroyed when the agent finishes (TTL ${ttl} min backstop)`
      : `Destroyed ${ttl} min after launch`;

  const confirmDialog = confirm && (
    <ConfirmDialog
      title={confirm.title}
      message={confirm.message}
      confirmLabel={confirm.label || "Remove"}
      danger
      onCancel={() => setConfirm(null)}
      onConfirm={() => { confirm.action(); setConfirm(null); }}
    />
  );

  // Connect the provider (no token yet): show the catalog steps + doc links,
  // then take the token. Saving flips this view into the profile form.
  if (!hasToken) {
    return (
      <div className="settings-form">
        {confirmDialog}
        <h3>Connect {catalog.name}</h3>
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
        <div className="row-actions">
          <button className="btn primary" disabled={!token.trim() || busy} onClick={saveToken}>{busy ? "Saving…" : "Save token"}</button>
        </div>
        <p className="muted small">The token stays on this device and is sent only to {catalog.name}.</p>
        {err && <div className="banner error inline" role="alert">{err}</div>}
        {msg && <div className="banner inline">{msg}</div>}
      </div>
    );
  }

  // Token saved: read a summary, then the form, with running machines and the
  // destructive actions tucked behind disclosures.
  return (
    <div className="settings-form">
      {confirmDialog}
      <div className="vault-title-row">
        <div>
          <h3>{setupId ? (setupName || `${catalog.name} profile`) : `New ${catalog.name} profile`}</h3>
          <p className="muted small">{catalog.name} · token saved on this device</p>
        </div>
        <span className="chip ok">{catalog.name} connected</span>
      </div>

      <div className="vault-detail-grid">
        <span className="muted">Provider</span><strong>{catalog.name}</strong>
        <span className="muted">Lifecycle</span><strong>{lifecycleSummary}</strong>
        <span className="muted">Est. cost</span><strong>{costHint ? `${costHint}${suspendsWhenIdle ? " while active · ~$0 idle" : ""} · billed by ${catalog.name}` : `provider's live rate · billed by ${catalog.name}`}</strong>
      </div>

      <label className="field-label">Name</label>
      <input className="picker-search" value={setupName} onChange={(e) => setSetupName(e.target.value)} placeholder="e.g. EU quick tasks" />

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
          <label className="field-label">Auto-destroy after</label>
          <select className="picker-search" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
            {EPHEMERAL_TTL_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
          <label className="checkbox-row">
            <input type="checkbox" checked={teardownOnAgentFinish} onChange={(e) => setTeardownOnAgentFinish(e.target.checked)} />
            <span>Destroy as soon as the agent finishes <span className="muted small">(the TTL above stays a safety fallback; the launching device must be online)</span></span>
          </label>
        </>
      )}

      <div className="banner inline">The repo this machine works on comes from the composer when you launch — it isn't set here.</div>

      <div className="row-actions">
        <button className="btn primary" disabled={busy || !setupName.trim()} onClick={savePrefs}>{busy ? "Saving…" : setupId ? "Save profile" : "Create profile"}</button>
      </div>
      {savedMsg && <div className="banner inline">{savedMsg}</div>}
      {msg && <div className="banner inline">{msg}</div>}
      {err && <div className="banner error inline" role="alert">{err}</div>}

      {machines.length > 0 && (
        <details className="vault-advanced" open>
          <summary>Running machines ({machines.length})</summary>
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
                        action: () => controller.destroyEphemeral(m).then(refreshMachines).catch((error) => setErr(String((error as Error)?.message || error))),
                      });
                    }}
                  >
                    Destroy
                  </button>
                }
              />
            ))}
          </div>
        </details>
      )}

      <details className="vault-advanced">
        <summary>Danger zone</summary>
        <div className="row-actions">
          {setupId && (
            <button className="btn danger-ghost" onClick={() => setConfirm({
              title: "Remove profile?",
              message: `Remove ${setupName || "this profile"}? Running machines are not affected.`,
              label: "Remove",
              action: () => controller.removeEphemeralConfig(setupId).then(() => { onSetupsChanged(); onBack(); }),
            })}>Remove profile</button>
          )}
          <button
            className="btn danger-ghost"
            onClick={() => setConfirm({
              title: "Forget provider token?",
              message: `Forget the ${catalog.name} token on this device?`,
              action: () => controller.removeEphemeralToken(providerId).then(() => {
                setHasToken(false);
                onKeysChanged();
              }),
            })}
          >
            Forget {catalog.name} token
          </button>
        </div>
      </details>
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
