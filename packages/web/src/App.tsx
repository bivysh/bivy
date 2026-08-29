// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { buildInboxItems, deriveActivation, cancelAutomationRun, deriveArtifacts, fetchAutomationRun, recordProductMetric, retryAutomationRun, type AccountAutomationRun, type GithubQueueItem } from "@bivy/core";
import { useAppState } from "./store/useStore.js";
import { SessionList } from "./components/SessionList.js";
import { ChatView } from "./components/ChatView.js";
import { Composer } from "./components/Composer.js";
import { ApprovalStack } from "./components/ApprovalCard.js";
import { QuestionStack } from "./components/QuestionCard.js";
import { TurnAttentionCard } from "./components/TurnAttentionCard.js";
import { UpdatePrompt } from "./components/UpdatePrompt.js";
import { SetupNotice } from "./components/SetupNotice.js";
import { NodeSwitcher } from "./components/NodeSwitcher.js";
import { closeSettings, getSettingsRoute, openSettings, setSettingsView, subscribeSettingsRoute } from "./settingsRoute.js";
import { closeAutomations, getAutomationsRoute, openAutomations, setAutomationsSection, subscribeAutomationsRoute } from "./automationsRoute.js";
// openAutomations({ setup }) is the sole entry for source connection lifecycle.
import { closeRun, getRunRoute, openRun, subscribeRunRoute } from "./runRoute.js";
import { dismissSignInRequest, getSignInRequest, subscribeSignInRequest } from "./signInRequest.js";
import { RunDetails } from "./components/RunDetails.js";
import { SessionMenu } from "./components/SessionMenu.js";
import { TuiLockedView } from "./components/TuiLockedView.js";
import { GithubPill } from "./components/GithubPill.js";
import { RunPill } from "./components/RunPill.js";
import { classifySource, isLiveRunSession, isRunLogSession } from "./sessionSource.js";
import { indexRunEvidence, failingCheckNames } from "./runEvidence.js";
import { SessionChangesSheet, countUniqueEditedFiles } from "./components/SessionChangesSheet.js";
import { ArtifactsSheet } from "./components/ArtifactsSheet.js";
import { ErrorToast } from "./components/ErrorToast.js";
import { NoticeToast } from "./components/NoticeToast.js";
import { Spinner } from "./components/Spinner.js";
import { StatusDot } from "./components/StatusDot.js";
import { EphemeralSheet } from "./components/Ephemeral.js";
import { FirstRunModelAuthSheet } from "./components/FirstRunModelAuth.js";
import { FirstRunOnboarding } from "./components/FirstRunOnboarding.js";
import { NodePicker } from "./components/Pickers.js";
import { ConnectRunner } from "./components/ConnectRunner.js";
import { EPHEMERAL_MACHINES_ENABLED } from "./flags.js";
import { useCloudMachinesEnabled } from "./cloudMachines.js";
import { PwaLifecycleNotice } from "./components/PwaLifecycleNotice.js";
import { clearQueuedPrompts, markPromptQueued, setFollowupQueuedPrompts, setTurnActive } from "./pwaLifecycle.js";
// The terminal pulls in xterm + its GPU/search/link addons (~a third of the JS
// bundle). It's an on-demand overlay, so load it lazily to keep the initial app
// paint fast; the chunk is fetched the first time the user opens a terminal.
const TerminalOverlay = lazy(() =>
  import("./components/Terminal.js").then((m) => ({ default: m.TerminalOverlay })),
);
const ReadinessChecklist = lazy(() =>
  import("./components/ReadinessChecklist.js").then((m) => ({ default: m.ReadinessChecklist })),
);
// Settings and Automations are URL-backed overlays most sessions never open;
// each is one of the largest components in the app, so they load on demand too.
const Settings = lazy(() => import("./components/Settings.js").then((m) => ({ default: m.Settings })));
const AutomationsView = lazy(() =>
  import("./components/AutomationsView.js").then((m) => ({ default: m.AutomationsView })),
);
import { useEdgeSwipe } from "./useEdgeSwipe.js";
import { controller } from "./store/useStore.js";
import { statusClass, statusDotState, statusLabel } from "./sessionStatus.js";

export function App() {
  const state = useAppState();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => localStorage.getItem("bivy:first-run-onboarding") === "done");
  // Settings is URL-backed (#78) — `settingsRoute` mirrors the `/settings` /
  // `/settings/:view` route the same way useAppState mirrors the session
  // store, and is null whenever the URL is on anything else (Settings closed).
  const settingsRoute = useSyncExternalStore(subscribeSettingsRoute, getSettingsRoute);
  // Automations is a first-class destination reached from the sidebar foot,
  // URL-backed the same overlay way Settings is (see automationsRoute.ts).
  const automationsOpen = useSyncExternalStore(subscribeAutomationsRoute, getAutomationsRoute);
  // The routable Run detail screen (/runs/:runId), URL-backed the same overlay
  // way Settings and Automations are (see runRoute.ts). Null whenever the URL is
  // on anything else. A copied Run URL restores this directly on cold load.
  const runRoute = useSyncExternalStore(subscribeRunRoute, getRunRoute);
  // Returning from a GitHub App redirect reloads the SPA — finish in Automations
  // (the sole place for source connections), not Settings.
  const githubAppReturning = state.presentation.githubApp?.returning;
  useEffect(() => {
    if (githubAppReturning) openAutomations({ setup: "github" });
  }, [githubAppReturning]);
  const cloudMachinesOptIn = useCloudMachinesEnabled();
  const cloudMachinesEnabled = EPHEMERAL_MACHINES_ENABLED && cloudMachinesOptIn;
  const [ephemeralOpen, setEphemeralOpen] = useState(false);
  // Full-session file changes sheet — opened from the run pill / summary sheet
  // ("N files edited"), not a card stacked above the composer.
  const [changesSheetOpen, setChangesSheetOpen] = useState(false);
  // Session/Run artifacts sheet — opened from the run pill ("N artifacts"),
  // mirroring the changes sheet above. The projection itself is a pure fold
  // over the transcript the store already holds (see deriveArtifacts) — no
  // extra round trip to the node.
  const [artifactsSheetOpen, setArtifactsSheetOpen] = useState(false);
  const artifacts = useMemo(() => deriveArtifacts(state.activeSession.transcript), [state.activeSession.transcript]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  /** A live `bivy run` PTY selected from the sidebar; null means open the
   * ordinary shell terminal for the active chat/node. */
  const [terminalTarget, setTerminalTarget] = useState<string | null>(null);
  /** True when the open/opening terminal is the standalone (session-less)
   *  one — always the selected node's default workspace, never the active
   *  chat's cwd. See #460. */
  const [terminalStandalone, setTerminalStandalone] = useState(false);
  /** "Continue in terminal": the overlay hands the active chat session off to
   *  the runtime's interactive TUI (the reverse of "continue in chat"). */
  const [terminalTui, setTerminalTui] = useState(false);
  /** A live run-terminal the user picked from the sidebar, before they choose
   *  Open terminal vs Use chat. The first screen for an in-terminal session —
   *  mirrors TuiLockedView for chat sessions that already have a TUI open. */
  const [pendingRunTerm, setPendingRunTerm] = useState<{ termId: string; nodeId?: string } | null>(null);
  // Node picker for the standalone terminal button — only shown when there's
  // more than one node to choose from (see openStandaloneTerminal).
  const [terminalNodePicker, setTerminalNodePicker] = useState(false);
  // Polled at the app level so the GitHub Queue settings panel has data ready
  // the moment it opens — see #388. Hosted-only: the queue is account-level
  // control-plane state, unavailable in direct mode.
  const [githubQueue, setGithubQueue] = useState<GithubQueueItem[] | null>(null);
  // Automation runs feed the Inbox's authoritative automation items (runs that
  // need attention or failed). Same account-level, hosted-only, polled-at-shell
  // shape as the GitHub queue above.
  const [automationRuns, setAutomationRuns] = useState<AccountAutomationRun[] | null>(null);
  // Ids of attention items the user has already looked at (opened the mobile
  // session drawer since they arrived). Drives the red dot on the ☰ burger:
  // it lights only for attention that appeared while the list was out of view.
  // In-memory by design — a reload re-surfaces current attention, which is the
  // safe default (better to re-show than to silently swallow a blocked agent).
  const [seenAttn, setSeenAttn] = useState<Set<string>>(() => new Set());
  const refreshGithubQueue = useCallback(() => {
    if (controller.direct || !state.connection.signedIn) return;
    controller.fetchGithubQueue().then(setGithubQueue).catch(() => {});
  }, [state.connection.signedIn]);
  const refreshAutomationRuns = useCallback(() => {
    if (controller.direct || !state.connection.signedIn) return;
    controller.fetchAutomationRuns().then(setAutomationRuns).catch(() => {});
  }, [state.connection.signedIn]);
  useEffect(() => {
    if (controller.direct || !state.connection.signedIn) return;
    refreshGithubQueue();
    refreshAutomationRuns();
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") { refreshGithubQueue(); refreshAutomationRuns(); }
    }, 30000);
    return () => clearInterval(id);
  }, [refreshGithubQueue, refreshAutomationRuns, state.connection.signedIn]);
  // sessionId → the run that produced it, joined from the queue's evidence.
  // Feeds the sidebar's exception hints and the run pill's outcome. Declared up
  // here (not by activeSession below) so the hook stays above any early return.
  const runEvidence = useMemo(() => indexRunEvidence(githubQueue), [githubQueue]);
  const inboxItems = useMemo(() => buildInboxItems({
    sessions: state.sessionIndex.sessions,
    approvals: state.activeSession.approvals,
    questions: state.activeSession.questions,
    nodes: state.connection.nodes,
    queue: githubQueue ?? [],
    runs: automationRuns ?? [],
  }), [state.sessionIndex.sessions, state.activeSession.approvals, state.activeSession.questions, state.connection.nodes, githubQueue, automationRuns]);
  // Something needs the user that they haven't seen yet → the ☰ burger wears a
  // red dot. Opening the session drawer (openDrawer) marks the current set seen.
  const attnUnseen = inboxItems.some((it) => !seenAttn.has(it.id));
  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
    setSeenAttn(new Set(inboxItems.map((it) => it.id)));
  }, [inboxItems]);
  // Attention must remain visible when Bivy is a background tab or installed
  // PWA. The Inbox is authoritative; mirror only its content-free count into
  // browser chrome and the OS app badge.
  useEffect(() => {
    const count = inboxItems.length;
    document.title = count > 0 ? `(${count}) Bivy` : "Bivy";
    const badge = navigator as Navigator & {
      setAppBadge?: (contents?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    const update = count > 0 ? badge.setAppBadge?.(count) : badge.clearAppBadge?.();
    void update?.catch(() => {}); // unsupported/blocked badge APIs are non-fatal
    return () => {
      document.title = "Bivy";
      void badge.clearAppBadge?.().catch(() => {});
    };
  }, [inboxItems.length]);
  // Signed in on the hosted app but no node yet: poll for a newly-installed
  // machine so the empty state advances to the live app the moment the node
  // dials in — the user shouldn't have to hit "Refresh nodes" after running the
  // installer. Stops as soon as a node is selected (the card disappears).
  const awaitingNode = !controller.direct && state.connection.signedIn && !state.connection.currentNodeId;
  useEffect(() => {
    if (!awaitingNode) return;
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") void controller.refreshNodes();
    }, 4000);
    return () => clearInterval(id);
  }, [awaitingNode]);
  // Focus view: collapse interim messages (thinking, tool cards, intermediate
  // assistant prose) down to just the conversation. Persisted so the choice
  // sticks across reloads and session switches.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("bivy.focusView") === "1");
  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem("bivy.focusView", next ? "1" : "0");
      return next;
    });
  }, []);
  const online = state.connection.status === "online";
  useEffect(() => setTurnActive(state.activeSession.working), [state.activeSession.working]);
  useEffect(() => { if (online) clearQueuedPrompts(); }, [online]);
  const queuedFollowupCount = Object.values(state.sessionIndex.followupsBySession).reduce((total, items) => total + items.length, 0);
  useEffect(() => setFollowupQueuedPrompts(queuedFollowupCount), [queuedFollowupCount]);
  const activation = useMemo(() => deriveActivation({
    accountSignedIn: controller.direct ? true : state.connection.signedIn,
    machineOnline: state.connection.status === "online" ? true : state.connection.status === "offline" ? false : undefined,
    agentInstalled: state.catalogs.runtimes.length
      ? state.catalogs.runtimes.some((runtime) => String(runtime.status ?? "available") === "available" && runtime.supportTier === "supported")
      : undefined,
    credentialValid: state.catalogs.activationReadiness ? state.catalogs.activationReadiness.credential.ok : undefined,
    repositoryReady: state.catalogs.activationReadiness ? state.catalogs.activationReadiness.repository.ok : undefined,
    agentAnswered: state.activeSession.transcript.some((entry) => entry.role === "assistant" && Boolean(entry.text) && !entry.tool) ? true : undefined,
  }), [state.catalogs.activationReadiness, state.catalogs.runtimes, state.connection.signedIn, state.connection.status, state.activeSession.transcript]);
  // Latch: has this client ever had a live connection this run? Once true, we
  // treat the WHOLE transient reconnect window as still-composable — not just the
  // brief "reconnecting" beat, but the redial's "connecting" and any re-pair
  // "linking"/"pairing" phases it passes through on the way back. A ref (not
  // state) because it only ever flips false→true and must never itself force a
  // render; status changes already re-render.
  const everConnectedRef = useRef(false);
  if (online) everConnectedRef.current = true;

  // A node blip flips the status through "reconnecting" → "connecting" → back to
  // "online" (often several times as the backoff loop retries). Don't tear the
  // composer out from under the user for that: keep it typable and let a send
  // queue on the transport (it flushes the moment the socket is back), exactly
  // like a messaging app that stays composable through a signal drop.
  //
  // Crucially this must span the *entire* reconnect, including the redial's
  // "connecting" phase. Earlier this only spared "reconnecting", so every redial
  // still flipped the textarea `disabled` true for its "connecting" leg — and a
  // disabled field is blurred by the browser (mobile also drops the keyboard),
  // which can't be re-summoned programmatically without a user gesture. That was
  // the "composer loses focus / keyboard disappears, several times in short
  // order" churn. Keeping `disabled` stable across the reconnect means focus is
  // never lost in the first place.
  //
  // The textarea only truly locks when we're offline, or still doing the very
  // first connect (no prior live pipe, nothing to preserve, and typing can't be
  // queued to a node we've never reached).
  const transientReconnect =
    state.connection.status === "reconnecting" ||
    (everConnectedRef.current &&
      (state.connection.status === "connecting" || state.connection.status === "linking" || state.connection.status === "pairing"));
  // The active session is being driven by its interactive TUI (single writer):
  // chat sends are refused by the node until the TUI exits. Rather than let a
  // send fail with an error, lock the composer and show a banner offering to
  // jump to the terminal or take the session back into chat.
  const activeTuiLocked = Boolean(state.activeSession.activeSessionId && state.sessionIndex.tuiSessions.includes(state.activeSession.activeSessionId));
  // When the node is an offline-but-resumable ephemeral machine (a suspended
  // Sprite we hold the key for), keep the composer usable: sending IS the resume
  // gesture — controller.sendPrompt wakes the machine and replays the message.
  // A picked-but-unlaunched ephemeral runner also keeps the composer usable:
  // sending IS the launch — controller.sendPrompt provisions the machine, binds
  // the session, and replays the message once it's online (no launch button).
  const canCompose = (online || transientReconnect || controller.isCurrentNodeResumable() || Boolean(state.draft.ephemeralConfig)) && !activeTuiLocked;

  // Left-edge swipe opens the sidebar drawer; swipe-left closes it (mobile).
  useEdgeSwipe({ isOpen: drawerOpen, onOpen: openDrawer, onClose: () => setDrawerOpen(false) });

  // Run an inline notice action button (e.g. a node-emitted "/new"). Declared
  // before any early return so hook order stays stable across renders (stable
  // identity too — controller is a singleton — so ChatView's memoized entries
  // aren't forced to re-render on every update).
  const runCommand = useCallback((name: string, _args?: string) => {
    switch (name) {
      case "/new": controller.newSession(); break;
      case "/resume":
        // Manual resume: continue the turn a restart interrupted. Sent as a normal
        // prompt to the active session so it streams and re-arms the turn state.
        controller.sendPrompt(
          "Please continue — your previous turn was interrupted by a restart before it finished. Pick up exactly where you left off and finish what you were doing.",
        );
        break;
    }
  }, []);

  // Standalone (session-less) terminal: opened from the sidebar button, always
  // scoped to a node's default workspace rather than any chat session. Skips
  // straight to that node when there's only one to choose from — direct/local
  // mode always has exactly one, and a fresh relay account often does too —
  // otherwise it opens a node picker (defaulting to the current node) so the
  // user can send it to a different node. See #460.
  const openStandaloneTerminal = useCallback(() => {
    setDrawerOpen(false);
    // Same lazy-refresh guard as the sidebar's node filter (SessionList): the
    // node list is fetched once on connect, but refresh it defensively here too
    // so a stale-empty list can't be misread as "only one node" and wrongly
    // skip the picker.
    if (!controller.direct && state.connection.nodes.length === 0) void controller.refreshNodes();
    if (controller.direct || state.connection.nodes.length <= 1) {
      setTerminalTarget(null);
      setTerminalStandalone(true);
      setTerminalTui(false);
      setTerminalOpen(true);
      return;
    }
    setTerminalNodePicker(true);
  }, [state.connection.nodes]);

  const pickTerminalNode = useCallback(
    (nodeId: string) => {
      setTerminalNodePicker(false);
      if (!controller.direct && nodeId !== state.connection.currentNodeId) controller.switchNode(nodeId);
      setTerminalTarget(null);
      setTerminalStandalone(true);
      setTerminalTui(false);
      setTerminalOpen(true);
      setDrawerOpen(false);
    },
    [state.connection.currentNodeId],
  );

  // A `bivy run` terminal picked from the sidebar (SessionList's runTerminals
  // rows) now carries the id of whichever node owns it — that row may not
  // belong to the currently connected node at all, since the sidebar shows
  // every node's terminals (issue #99). Attaching sends over the live
  // transport, so a cross-node pick must switch (and wait for the new node to
  // come online) before opening the overlay, the same way openSessionOnNode
  // does for chat sessions.
  //
  // We do NOT open the terminal overlay immediately: a live run is a
  // single-writer conversation, so the first screen is the same choice the
  // TUI-locked chat path shows — Open terminal / Use chat (when takeover is
  // supported). Auto-opening the PTY was the regression that skipped that
  // handoff and hid "Continue in chat".
  const pickTerminal = useCallback(
    (termId: string, nodeId?: string) => {
      const select = () => {
        setPendingRunTerm({ termId, nodeId });
        setTerminalOpen(false);
        setTerminalTarget(null);
        setTerminalStandalone(false);
        setTerminalTui(false);
      };
      setDrawerOpen(false);
      if (!controller.direct && nodeId && nodeId !== state.connection.currentNodeId) {
        void controller.connectToNode(nodeId).then(select).catch((err) => {
          controller.store.setError(err instanceof Error ? err.message : String(err));
        });
        return;
      }
      select();
    },
    [state.connection.currentNodeId],
  );

  // A finished `bivy run` that kept only its terminal scrollback (source
  // "cli:log"): show that log read-only in the terminal overlay. The overlay
  // attaches by id; the node replays the stored output and the exit, so no
  // shell is opened and nothing can be typed into it. Cross-node rows switch
  // first, like pickTerminal.
  const openRunLog = useCallback(
    (sessionId: string, nodeId?: string) => {
      const show = () => {
        setPendingRunTerm(null);
        setTerminalTarget(sessionId);
        setTerminalStandalone(true);
        setTerminalTui(false);
        setTerminalOpen(true);
      };
      setDrawerOpen(false);
      if (!controller.direct && nodeId && nodeId !== state.connection.currentNodeId) {
        void controller.connectToNode(nodeId).then(show).catch((err) => {
          controller.store.setError(err instanceof Error ? err.message : String(err));
        });
        return;
      }
      show();
    },
    [state.connection.currentNodeId],
  );

  const openPendingRunTerminal = useCallback(() => {
    if (!pendingRunTerm) return;
    setTerminalTarget(pendingRunTerm.termId);
    setTerminalStandalone(false);
    setTerminalTui(false);
    setTerminalOpen(true);
    // Keep pendingRunTerm so closing the overlay returns to the handoff screen
    // rather than dumping the user on an empty chat.
  }, [pendingRunTerm]);

  const takeoverPendingRun = useCallback(() => {
    if (!pendingRunTerm) return;
    // Clear the handoff immediately so the next openSession (from
    // terminal.takeover.result) paints the chat rather than this screen.
    const termId = pendingRunTerm.termId;
    setPendingRunTerm(null);
    controller.sendTerminal({ kind: "terminal.takeover", termId });
  }, [pendingRunTerm]);

  // Drop the run-terminal handoff if its live PTY disappears (exited/takeover).
  useEffect(() => {
    if (!pendingRunTerm) return;
    if (!state.sessionIndex.runTerminals.some((t) => t.termId === pendingRunTerm.termId)) {
      setPendingRunTerm(null);
    }
  }, [pendingRunTerm, state.sessionIndex.runTerminals]);

  // "Continue in terminal": open the overlay bound to the active chat session in
  // interactive-TUI mode. The overlay sends `terminal.open.tui`, which resumes
  // this same conversation in the runtime's native CLI — the reverse of the
  // terminal's "continue in chat" (takeover). Gated on the session runtime's
  // `interactiveTui` capability at the call site (SessionMenu).
  const continueInTerminal = useCallback(() => {
    setTerminalTarget(null);
    setTerminalStandalone(false);
    setTerminalTui(true);
    setTerminalOpen(true);
  }, []);

  // "Take over in chat" from the TUI lock banner: ask the node to stop the TUI
  // that owns the active session; it rebuilds the session from disk and
  // broadcasts `terminal.tui {active:false}`, which unlocks the composer.
  const takeoverInChat = useCallback(() => {
    if (state.activeSession.activeSessionId) controller.closeSessionTui(state.activeSession.activeSessionId);
  }, [state.activeSession.activeSessionId]);

  // Push taps and copied inbox links use the same `attention` target. Wait until
  // the owning session's live card has arrived, then reveal and focus it.
  useEffect(() => {
    const attention = new URLSearchParams(location.search).get("attention");
    if (!attention || !state.activeSession.activeSessionId) return;
    const target = document.getElementById(`attention-${encodeURIComponent(attention)}`);
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }, [state.activeSession.activeSessionId, state.activeSession.approvals, state.activeSession.questions, state.activeSession.turnAttentions]);

  // Auth/setup gates, derived from reactive store fields (not read live off
  // localStorage) so signing in swaps the sign-in screen for the app shell the
  // instant the token lands — no page reload needed. `direct` (local/loopback
  // mode) never gates on a control-plane session.
  const needsAuth = !controller.direct && !controller.solo && !state.connection.signedIn;
  // A solo pairing never hits the auth gate, but account-only surfaces
  // (Automations, cloud machine profiles) can summon the sign-in screen on
  // demand — see signInRequest.ts. Dismissable, unlike the boot-time gate.
  const signInRequested = useSyncExternalStore(subscribeSignInRequest, getSignInRequest);
  // Picking an ephemeral runner counts as having chosen where to run, even
  // before its machine exists — show the composer, not the onboarding screen.
  const needsNode = !controller.direct && state.connection.signedIn && !state.connection.currentNodeId && !state.draft.ephemeralConfig;
  const showFirstRunOnboarding = !controller.direct && state.connection.signedIn && !onboardingDismissed
    && state.sessionIndex.sessions.length === 0 && state.activeSession.transcript.length === 0;

  // Hosted control plane, not signed in yet: show the sign-in screen instead of a
  // dead shell. Once signed in we always render the normal app — a node is picked
  // in-place from the header NodeSwitcher, not behind a separate full-screen gate,
  // so a refresh lands on the sidebar rather than a "Choose a node" wall.
  if (needsAuth || signInRequested) {
    return (
      <>
        <SetupNotice onDismiss={needsAuth ? undefined : dismissSignInRequest} />
        <div className="toast-stack">
          <NoticeToast />
          <UpdatePrompt />
        </div>
      </>
    );
  }

  const closeDrawer = () => setDrawerOpen(false);
  const activeSession = state.sessionIndex.sessions.find((s) => s.sessionId === state.activeSession.activeSessionId);
  // Every active session shows the run card (source + live status) in the band
  // above the composer; `null` for a draft (no session yet) falls back to the
  // plain GitHub pill.
  const activeRunSource = activeSession ? classifySource(activeSession.source) : null;
  // A forked session's sheet gets its own "Forked from" row. The parent's name
  // is resolved from the local session list when known; it may live on
  // another node or be gone by now, so this degrades to a bare id.
  const activeForkedFrom = activeSession?.forkedFrom
    ? { sessionId: activeSession.forkedFrom, name: state.sessionIndex.sessions.find((s) => s.sessionId === activeSession.forkedFrom)?.name }
    : undefined;
  const activeSessionNodeId = activeSession?.nodeId || state.connection.currentNodeId || undefined;
  const activeSessionNode = state.connection.nodes.find((node) => node.id === activeSessionNodeId);
  const activeSessionNodeLabel = activeSessionNode
    ? `${activeSessionNode.name || activeSessionNode.id} (${activeSessionNode.id})`
    : activeSessionNodeId;
  const isRepoSession = Boolean(activeSession?.source && String(activeSession.source).startsWith("repo:"));
  // "Continue in terminal" is offered only when this session's runtime can hand
  // itself to its native TUI on the node (capability `interactiveTui`) — the
  // analog of the terminal's capability-gated "continue in chat". Absent caps
  // (older node / runtime not yet loaded) default to hidden.
  // Prefer the live session's runtime identity. Older/remote session summaries
  // can omit `runtimeId` even though the active-session projection has it; in
  // that case the capability lookup must still be able to expose the handoff.
  const activeRuntimeId = activeSession?.runtimeId ?? state.activeSession.activeRuntimeId;
  const activeRuntimeCaps = state.catalogs.runtimes.find((r) => r.id === activeRuntimeId)?.capabilities as
    | { interactiveTui?: boolean }
    | undefined;
  const canContinueInTerminal = online && Boolean(activeRuntimeCaps?.interactiveTui);

  // Approval/question cards render inline in the active session's chat scroll, so
  // only show the ones that belong to that session. Items are still kept globally
  // in the store (for the sidebar "needs response" indicator); we just don't render
  // another session's cards into whichever chat happens to be on screen. Items with
  // no sessionId are treated as global and shown everywhere.
  const activeApprovals = state.activeSession.approvals.filter((a) => !a.sessionId || a.sessionId === state.activeSession.activeSessionId);
  const activeQuestions = state.activeSession.questions.filter((q) => !q.sessionId || q.sessionId === state.activeSession.activeSessionId);
  const activeTurnAttention = state.activeSession.turnAttentions.find((a) => a.sessionId === state.activeSession.activeSessionId);
  return (
    <div className="app">
      <aside className={`sidebar${drawerOpen ? " open" : ""}`}>
        <div className="sidebar-head">
          <span className="brand">Bivy</span>
          <div className="sidebar-head-actions">
            {/* Standalone terminal: independent of any session, opened at the
                picked node's workspace folder. Sits to the left of "+ New" —
                see #460. */}
            <button
              className="btn ghost icon term-btn"
              onClick={openStandaloneTerminal}
              disabled={!online}
              title="Terminal"
              aria-label="Open standalone terminal"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="m7 9 3 3-3 3" />
                <path d="M13 15h4" />
              </svg>
            </button>
            {/* Discover/adopt a provider-native session (Claude Code, Codex, …)
                started outside Bivy — issue #156. This used to be a header icon,
                but a rarely-used discovery/adopt flow didn't belong crammed next
                to "+ New"; it now lives in Settings → Import session. */}
            <button
              className="btn sm ghost"
              onClick={() => {
                setPendingRunTerm(null);
                controller.newSession();
                closeDrawer();
              }}
              title="New session"
            >
              + New
            </button>
          </div>
        </div>
        <SessionList
          runEvidence={runEvidence}
          automationsActive={Boolean(automationsOpen)}
          onOpenAutomations={() => {
            openAutomations();
            closeDrawer();
          }}
          onPick={(id, path, nodeId) => {
            setPendingRunTerm(null);
            closeDrawer();
            // A `bivy run` session whose PTY is still alive (advertised by its
            // node as source cli + working — typically learned via the account
            // list, from a node we aren't connected to) is a running terminal:
            // hand off to it like a Running row, never resume it as a chat on
            // top of the live TUI. If the PTY turns out to be gone, the run
            // ended and its saved session opens as a normal chat.
            const row = state.sessionIndex.sessions.find((s) => s.sessionId === id);
            // A finished run that only kept its terminal scrollback: open the
            // log read-only in the terminal overlay (the node replays it on
            // attach), on the node that owns it.
            if (row && isRunLogSession(row)) {
              openRunLog(id, nodeId);
              return;
            }
            if (row && isLiveRunSession(row)) {
              void controller.findLiveRunTerminal(id, nodeId)
                .then((term) => {
                  if (term) pickTerminal(term.termId, term.nodeId ?? nodeId);
                  else controller.openSessionOnNode(id, path, nodeId);
                })
                .catch((err) => controller.store.setError(err instanceof Error ? err.message : String(err)));
              return;
            }
            controller.openSessionOnNode(id, path, nodeId);
          }}
          onPickTerminal={pickTerminal}
        />
        {/* Settings is the low-attention utility below the scrollable sidebar content. */}
        <div className="sidebar-foot">
          <button
            className="settings-gear"
            onClick={() => {
              openSettings();
              closeDrawer();
            }}
            title="Settings"
            aria-label="Settings"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>Settings</span>
          </button>
        </div>
      </aside>

      {drawerOpen && <div className="scrim" onClick={closeDrawer} />}

      <main className={`main${showFirstRunOnboarding ? " onboarding" : needsNode ? " needs-node" : ""}`}>
        <header className="topbar">
          <button
            className="btn ghost icon only-mobile burger-btn"
            onClick={openDrawer}
            aria-label={attnUnseen ? "Open sessions — something needs your attention" : "Open sessions"}
          >
            ☰
            {attnUnseen && <span className="attn-indicator" aria-hidden><StatusDot status="needs-action" /></span>}
          </button>
          <div className="topbar-title">
            <div className="topbar-title-row">
              {/* Same dot/color rules as the sidebar row (see sessionStatus.ts) —
                  a session opened here should read identically whether you're
                  looking at the list or already inside it. Only rendered once a
                  real session is open; a brand-new draft has no status yet. */}
              {activeSession && (
                <span title={statusLabel(activeSession)}>
                  <StatusDot status={statusDotState(activeSession)} label={statusLabel(activeSession)} />
                </span>
              )}
              <h1 className="title" title={needsNode ? "Connect a Machine" : state.activeSession.activeTitle}>
                {needsNode ? "Connect a Machine" : state.activeSession.activeTitle}
              </h1>
            </div>
            {/* Node stays below the title as a plain subtitle line — but it's
                still the real switcher button underneath, so it's selectable
                on a brand-new/draft session exactly as it is on a live one. */}
            {!controller.direct && !controller.solo && <NodeSwitcher />}
          </div>
          <div className="topbar-actions">
            {state.activeSession.activeSessionId && (
              <button
                className="btn ghost icon eye-btn"
                onClick={toggleCollapsed}
                title={collapsed ? "Focus view on — show all messages" : "Focus view — hide tool use"}
                aria-label="Toggle focus view"
                aria-pressed={collapsed}
              >
                {collapsed ? (
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                    <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                    <line x1="2" x2="22" y1="2" y2="22" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            )}
            {state.activeSession.activeSessionId && (
              <SessionMenu
                sessionId={state.activeSession.activeSessionId}
                name={state.activeSession.activeTitle}
                isRepo={isRepoSession}
                node={activeSessionNodeLabel}
                agent={activeSession?.agentName || activeSession?.runtimeId}
                workspace={activeSession?.workspace}
                worktree={activeSession?.worktree}
                branch={activeSession?.branch}
                sessionFile={activeSession?.path}
                auditHealth={activeSession?.auditHealth}
                eventLogHealth={activeSession?.eventLogHealth}
                onContinueInTerminal={canContinueInTerminal ? continueInTerminal : undefined}
              />
            )}
          </div>
        </header>

        {/* Device pairing/linking is a deliberate, one-time flow, so it keeps its
            full-width banner. A transient reconnect/connect, by contrast, used to
            drop this same bar in — pushing the whole page down on every network
            blip, which on mobile is constant and jarring. That state is now shown
            as a quiet spinner on the node status indicator (see NodeSwitcher)
            instead of reflowing the layout. */}
        {(state.connection.status === "pairing" || state.connection.status === "linking") && (
          <div className="banner" data-tone="neutral" role="status">
            <Spinner size="xs" />
            Linking this device…
          </div>
        )}

        {/* The connected node is running an older Bivy than the latest release.
            One tap runs `bivy update` on the node (it restarts on the new build;
            this banner clears itself once the socket reconnects up to date). */}
        {state.connection.nodeUpdate && (
          <div className="banner" data-tone="accent" role="status">
            <span className="banner-text">
              This machine runs Bivy {state.connection.nodeUpdate.current} — {state.connection.nodeUpdate.latest} is available.
            </span>
            <button
              className="btn sm primary banner-action"
              onClick={() => controller.updateNode()}
              disabled={state.connection.nodeUpdating}
            >
              {state.connection.nodeUpdating ? "Updating…" : "Update this machine"}
            </button>
          </div>
        )}

        {!showFirstRunOnboarding && !state.activeSession.activeSessionId && state.activeSession.transcript.length === 0 && state.sessionIndex.sessions.length === 0 && (
          <Suspense fallback={null}>
            <ReadinessChecklist
              activation={activation}
              onRemediate={{
                connect_machine: () => openSettings("nodes"),
                install_agent: () => (document.querySelector(".agent-pill") as HTMLButtonElement | null)?.click(),
                authenticate_credential: () => openSettings("providers"),
                grant_repository: () => (document.querySelector(".repo-pill") as HTMLButtonElement | null)?.click(),
                run_starter_task: () => (document.querySelector(".composer-input") as HTMLTextAreaElement | null)?.focus(),
              }}
            />
          </Suspense>
        )}

        {showFirstRunOnboarding && (
          <div className="connect-runner-scroll">
            <FirstRunOnboarding state={state} onDone={() => {
              localStorage.setItem("bivy:first-run-onboarding", "done");
              setOnboardingDismissed(true);
            }} />
          </div>
        )}

        {!showFirstRunOnboarding && needsNode && (
          <div className="connect-runner-scroll">
            <ConnectRunner
              nodes={state.connection.nodes}
              ephemeralEnabled={cloudMachinesEnabled}
              onPickNode={(nodeId) => controller.switchNode(nodeId)}
              onEphemeral={() => setEphemeralOpen(true)}
              onRefresh={() => controller.refreshNodes()}
            />
          </div>
        )}

        {pendingRunTerm && !terminalOpen ? (
          (() => {
            const run = state.sessionIndex.runTerminals.find((t) => t.termId === pendingRunTerm.termId);
            const runName = run?.name || run?.label || run?.agent || "Terminal session";
            const runNode = state.connection.nodes.find((n) => n.id === (run?.nodeId || pendingRunTerm.nodeId));
            // Same capability gate the Terminal overlay uses for "Continue in chat".
            const runtime = state.catalogs.runtimes.find((r) => r.id === String(run?.agent || ""));
            const caps = runtime?.capabilities as { sessionDiscovery?: boolean } | undefined;
            const canTakeover = Boolean(run?.sessionId) || Boolean(caps?.sessionDiscovery);
            return (
              <TuiLockedView
                sessionName={runName}
                nodeLabel={runNode?.name}
                online={state.connection.status !== "offline"}
                onOpenTerminal={openPendingRunTerminal}
                onUseChat={canTakeover ? takeoverPendingRun : undefined}
              />
            );
          })()
        ) : activeTuiLocked ? (
          <TuiLockedView
            sessionName={state.activeSession.activeTitle}
            nodeLabel={activeSessionNode?.name}
            online={state.connection.status !== "offline"}
            onOpenTerminal={continueInTerminal}
            onUseChat={takeoverInChat}
          />
        ) : (
          <>
            <ChatView
              entries={state.activeSession.transcript}
              working={state.activeSession.working}
              workingLabel={state.activeSession.workingLabel}
              // Whether there's no real session behind the current view — driven by
              // the session store rather than the URL, since the URL now moves to
              // `/settings/*` while Settings is open without changing (or clearing)
              // whatever session is open behind it.
              draftRoute={!state.activeSession.activeSessionId}
              opening={state.activeSession.opening}
              sessionKey={state.activeSession.activeSessionId}
              collapsed={collapsed}
              onAction={runCommand}
              footer={
                <>
                  <ApprovalStack approvals={activeApprovals} onResolve={(id, ok, remember) => controller.resolveApproval(id, ok, remember)} />
                  <QuestionStack
                    questions={activeQuestions}
                    onAnswer={(id, sessionId, answers) => controller.answerQuestion(id, sessionId, answers)}
                    onCancel={(id, sessionId) => controller.cancelQuestion(id, sessionId)}
                  />
                  {activeTurnAttention && (
                    <TurnAttentionCard
                      attention={activeTurnAttention}
                      onResolve={(sessionId, action) => controller.resolveTurnAttention(sessionId, action)}
                    />
                  )}
                </>
              }
            />

            {changesSheetOpen && (
              <SessionChangesSheet
                history={state.activeSession.changesHistory}
                checks={activeSession ? runEvidence.get(activeSession.sessionId)?.checks?.map((c) => ({ name: c.name, status: c.status })) : undefined}
                onClose={() => setChangesSheetOpen(false)}
              />
            )}

            {artifactsSheetOpen && (
              <ArtifactsSheet artifacts={artifacts} onClose={() => setArtifactsSheetOpen(false)} />
            )}

            <div className="composer-gh">
              {/* The run card now stands for every active session — an automation
                  trigger, a fork, or a plain hand-opened one — carrying whatever
                  applies: source, live status, token usage, fork lineage, file
                  edits, and (in its sheet) the run evidence and GitHub links.
                  Only a draft (no session yet) falls back to the bare GithubPill. */}
              {activeSession && activeRunSource ? (
                <RunPill
                  anchorId={`attention-${activeSession.sessionId}`}
                  source={activeRunSource}
                  statusClass={statusClass(activeSession)}
                  statusLabel={statusLabel(activeSession)}
                  gh={state.activeSession.github}
                  evidence={runEvidence.get(activeSession.sessionId)}
                  finishedAt={activeSession.finishedAt}
                  usage={state.activeSession.usage}
                  forkedFrom={activeForkedFrom}
                  filesEdited={countUniqueEditedFiles(state.activeSession.changesHistory)}
                  onOpenChanges={() => setChangesSheetOpen(true)}
                  artifactsCount={artifacts.length}
                  onOpenArtifacts={() => setArtifactsSheetOpen(true)}
                  onOpenRun={(runId) => openRun(runId)}
                  onRecover={(kind) => {
                    // C2: recover a terminal run using existing capabilities. fix/retry
                    // send a targeted prompt to this session; fork branches it off.
                    const sid = activeSession.sessionId;
                    const ev = runEvidence.get(sid);
                    const failed = ev ? failingCheckNames(ev) : [];
                    if (kind === "fork") { void controller.forkSession(sid); return; }
                    if (kind === "fix") {
                      controller.sendPrompt(failed.length
                        ? `The deterministic checks failed (${failed.join(", ")}). Please investigate the failures and fix them, then confirm the checks pass.`
                        : "This run did not finish cleanly. Please investigate what went wrong and fix it.");
                      return;
                    }
                    // retry
                    controller.sendPrompt(failed.length
                      ? `Please re-run the ${failed.join(", ")} check(s) and address anything that still fails.`
                      : "Please re-run the project checks and address anything that fails.");
                  }}
                />
              ) : (
                <GithubPill gh={state.activeSession.github} />
              )}
            </div>

            <PwaLifecycleNotice
              status={state.connection.status}
              hasCachedTranscript={state.activeSession.transcript.length > 0}
              machineName={activeSessionNode?.name || undefined}
            />
            <Composer
              state={state}
              disabled={!canCompose}
              disabledHint={
                state.connection.status === "offline"
                  ? activeSessionNode?.name
                    ? `${activeSessionNode.name} is offline — run \`bivy status\` there`
                    : "Machine offline — run `bivy status` on it"
                  : activeSessionNode?.name
                    ? `Connecting to ${activeSessionNode.name}…`
                    : "Connecting…"
              }
              working={state.activeSession.working}
              onSend={(text, attachments) => {
                if (state.connection.status !== "online") markPromptQueued();
                setTurnActive(true); // close the pre-`working` update-activation race
                controller.sendPrompt(text, attachments);
              }}
              onAbort={() => controller.abort()}
              onError={(message) => controller.store.setError(message)}
            />
          </>
        )}
      </main>

      {automationsOpen && (
        <Suspense fallback={null}>
        <AutomationsView
          state={state}
          section={automationsOpen.section}
          onSectionChange={setAutomationsSection}
          githubQueue={githubQueue}
          onRefreshGithubQueue={refreshGithubQueue}
          onOpenRun={(runId) => {
            // Land on the Run route: dismiss Automations onto the session behind
            // it first (replace, no extra history), then push /runs/:runId so
            // Back returns to that session rather than stacking two overlays.
            closeAutomations(state.activeSession.activeSessionId ? { kind: "session", id: state.activeSession.activeSessionId } : { kind: "new" });
            openRun(runId);
          }}
          onClose={() =>
            closeAutomations(
              state.activeSession.activeSessionId ? { kind: "session", id: state.activeSession.activeSessionId } : { kind: "new" },
            )
          }
          onOpenSession={(sessionId) => {
            // Deep-link a run into the chat session it produced. Resolve the
            // owning node/path from the unified session list so a cross-node
            // session opens the same way the sidebar and Settings do; then
            // dismiss Automations onto that session's route.
            const s = state.sessionIndex.sessions.find((x) => x.sessionId === sessionId);
            controller.openSessionOnNode(sessionId, s?.path, s?.nodeId);
            closeAutomations({ kind: "session", id: sessionId });
            closeDrawer();
          }}
        />
        </Suspense>
      )}

      {runRoute && (
        <RunDetails
          runId={runRoute.runId}
          load={(id) => fetchAutomationRun(controller.local, id)}
          onCancel={async (id) => { await cancelAutomationRun(controller.local, id); refreshAutomationRuns(); refreshGithubQueue(); }}
          onRetry={async (id) => { await retryAutomationRun(controller.local, id); refreshAutomationRuns(); refreshGithubQueue(); }}
          onReauthenticate={async (provider, machineId, reason) => {
            const targetNode = machineId || state.connection.currentNodeId;
            if (!targetNode) throw new Error("The Machine for this Run is not available.");
            await controller.connectToNode(targetNode);
            controller.store.setNeedsModelAuth({ nodeId: targetNode, provider, reason });
          }}
          resolveMachineName={(machineId) => state.connection.nodes.find((n) => n.id === machineId)?.name || undefined}
          isSessionResolvable={(sessionId) => state.sessionIndex.sessions.some((s) => s.sessionId === sessionId)}
          onReceiptReviewed={() => { void recordProductMetric(controller.local, "receipt_reviewed", matchMedia("(max-width: 700px)").matches ? "mobile" : "desktop").catch(() => {}); }}
          onOpenSession={(sessionId) => {
            const s = state.sessionIndex.sessions.find((x) => x.sessionId === sessionId);
            controller.openSessionOnNode(sessionId, s?.path, s?.nodeId);
            closeRun({ kind: "session", id: sessionId });
            closeDrawer();
          }}
          onClose={() =>
            closeRun(
              state.activeSession.activeSessionId ? { kind: "session", id: state.activeSession.activeSessionId } : { kind: "new" },
            )
          }
        />
      )}

      {settingsRoute && (
        <Suspense fallback={null}>
        <Settings
          state={state}
          view={settingsRoute.view}
          onViewChange={setSettingsView}
          onImported={(id) => {
            // importNativeSession already opened + navigated to the new session
            // (with its resume ref); just dismiss Settings onto that route.
            closeSettings({ kind: "session", id });
            closeDrawer();
          }}
          onRedirectToAutomations={(view) => {
            // Integrations + automation/policy sections moved to the Automations
            // hub. A stale `/settings/:view` deep link bounces there: source
            // connections open the connect sheet; the rest land on their tab.
            closeSettings(
              state.activeSession.activeSessionId ? { kind: "session", id: state.activeSession.activeSessionId } : { kind: "new" },
            );
            if (view === "github" || view === "linear" || view === "slack") {
              openAutomations({ setup: view });
            } else if (view === "queue" || view === "rulesets") {
              openAutomations({ section: view });
            } else {
              // Other stale sections (e.g. the removed Webhooks tab) land on Overview.
              openAutomations();
            }
            closeDrawer();
          }}
          onClose={() =>
            closeSettings(
              state.activeSession.activeSessionId ? { kind: "session", id: state.activeSession.activeSessionId } : { kind: "new" },
            )
          }
        />
        </Suspense>
      )}
      {ephemeralOpen && cloudMachinesEnabled && <EphemeralSheet onClose={() => setEphemeralOpen(false)} firstRun={needsNode} />}
      {state.presentation.needsModelAuth && <FirstRunModelAuthSheet state={state} />}
      {terminalNodePicker && (
        <NodePicker
          state={state}
          currentNodeId={state.connection.currentNodeId}
          onPick={pickTerminalNode}
          onClose={() => setTerminalNodePicker(false)}
        />
      )}
      {terminalOpen && (
        <Suspense fallback={null}>
          <TerminalOverlay
            sessionId={terminalStandalone ? null : state.activeSession.activeSessionId}
            attachTermId={terminalTarget}
            standalone={terminalStandalone}
            tui={terminalTui}
            onClose={() => {
              setTerminalOpen(false);
              setTerminalTarget(null);
              setTerminalStandalone(false);
              setTerminalTui(false);
              // Leaving a run-terminal overlay returns to the handoff screen when
              // that run was the selection; clear it only when the user dismisses
              // the handoff itself (new session / other pick).
            }}
          />
        </Suspense>
      )}

      {/* Shared fixed-position stack: ErrorToast and UpdatePrompt can
          legitimately both be showing at once — each used to independently be
          `position: fixed` at the same spot, so more than one showing at a
          time meant overlapping, illegible toasts. This wrapper stacks them
          instead. */}
      <div className="toast-stack">
        <NoticeToast />
        <ErrorToast />
        <UpdatePrompt />
      </div>
    </div>
  );
}
