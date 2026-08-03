// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type GithubQueueItem } from "@bivy/core";
import { useAppState } from "./store/useStore.js";
import { SessionList } from "./components/SessionList.js";
import { ChatView } from "./components/ChatView.js";
import { Composer } from "./components/Composer.js";
import { ApprovalStack } from "./components/ApprovalCard.js";
import { QuestionStack } from "./components/QuestionCard.js";
import { UpdatePrompt } from "./components/UpdatePrompt.js";
import { SetupNotice } from "./components/SetupNotice.js";
import { NodeSwitcher } from "./components/NodeSwitcher.js";
import { closeSettings, getSettingsRoute, openSettings, setSettingsView, subscribeSettingsRoute } from "./settingsRoute.js";
import { SessionMenu } from "./components/SessionMenu.js";
import { GithubPill } from "./components/GithubPill.js";
import { RunPill } from "./components/RunPill.js";
import { classifySource } from "./sessionSource.js";
import { indexRunEvidence } from "./runEvidence.js";
import { ChangesCard } from "./components/ChangesCard.js";
import { ErrorToast } from "./components/ErrorToast.js";
import { NoticeToast } from "./components/NoticeToast.js";
import { Settings } from "./components/Settings.js";
import { EphemeralSheet } from "./components/Ephemeral.js";
import { FirstRunModelAuthSheet } from "./components/FirstRunModelAuth.js";
import { NodePicker } from "./components/Pickers.js";
import { ConnectRunner } from "./components/ConnectRunner.js";
import { EPHEMERAL_MACHINES_ENABLED } from "./flags.js";
// The terminal pulls in xterm + its GPU/search/link addons (~a third of the JS
// bundle). It's an on-demand overlay, so load it lazily to keep the initial app
// paint fast; the chunk is fetched the first time the user opens a terminal.
const TerminalOverlay = lazy(() =>
  import("./components/Terminal.js").then((m) => ({ default: m.TerminalOverlay })),
);
import { useEdgeSwipe } from "./useEdgeSwipe.js";
import { controller } from "./store/useStore.js";
import { isUnseen, statusClass, statusLabel } from "./sessionStatus.js";

export function App() {
  const state = useAppState();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Settings is URL-backed (#78) — `settingsRoute` mirrors the `/settings` /
  // `/settings/:view` route the same way useAppState mirrors the session
  // store, and is null whenever the URL is on anything else (Settings closed).
  const settingsRoute = useSyncExternalStore(subscribeSettingsRoute, getSettingsRoute);
  // Returning from a GitHub App redirect reloads the SPA — re-open Settings on
  // the GitHub view so the user sees the flow finish.
  const githubAppReturning = state.githubApp?.returning;
  useEffect(() => {
    if (githubAppReturning) openSettings("github");
  }, [githubAppReturning]);
  const [ephemeralOpen, setEphemeralOpen] = useState(false);
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
  // Node picker for the standalone terminal button — only shown when there's
  // more than one node to choose from (see openStandaloneTerminal).
  const [terminalNodePicker, setTerminalNodePicker] = useState(false);
  // Polled at the app level so the GitHub Queue settings panel has data ready
  // the moment it opens — see #388. Hosted-only: the queue is account-level
  // control-plane state, unavailable in direct mode.
  const [githubQueue, setGithubQueue] = useState<GithubQueueItem[] | null>(null);
  const refreshGithubQueue = useCallback(() => {
    if (controller.direct || !state.signedIn) return;
    controller.fetchGithubQueue().then(setGithubQueue).catch(() => {});
  }, [state.signedIn]);
  useEffect(() => {
    if (controller.direct || !state.signedIn) return;
    refreshGithubQueue();
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") refreshGithubQueue();
    }, 30000);
    return () => clearInterval(id);
  }, [refreshGithubQueue]);
  // sessionId → the run that produced it, joined from the queue's evidence.
  // Feeds the sidebar's exception hints and the run pill's outcome. Declared up
  // here (not by activeSession below) so the hook stays above any early return.
  const runEvidence = useMemo(() => indexRunEvidence(githubQueue), [githubQueue]);
  // Signed in on the hosted app but no node yet: poll for a newly-installed
  // machine so the empty state advances to the live app the moment the node
  // dials in — the user shouldn't have to hit "Refresh nodes" after running the
  // installer. Stops as soon as a node is selected (the card disappears).
  const awaitingNode = !controller.direct && state.signedIn && !state.currentNodeId;
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
  const online = state.status === "online";
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
    state.status === "reconnecting" ||
    (everConnectedRef.current &&
      (state.status === "connecting" || state.status === "linking" || state.status === "pairing"));
  // The active session is being driven by its interactive TUI (single writer):
  // chat sends are refused by the node until the TUI exits. Rather than let a
  // send fail with an error, lock the composer and show a banner offering to
  // jump to the terminal or take the session back into chat.
  const activeTuiLocked = Boolean(state.activeSessionId && state.tuiSessions.includes(state.activeSessionId));
  // When the node is an offline-but-resumable ephemeral machine (a suspended
  // Sprite we hold the key for), keep the composer usable: sending IS the resume
  // gesture — controller.sendPrompt wakes the machine and replays the message.
  const canCompose = (online || transientReconnect || controller.isCurrentNodeResumable()) && !activeTuiLocked;

  // Left-edge swipe opens the sidebar drawer; swipe-left closes it (mobile).
  useEdgeSwipe({ isOpen: drawerOpen, onOpen: () => setDrawerOpen(true), onClose: () => setDrawerOpen(false) });

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
    if (!controller.direct && state.nodes.length === 0) void controller.refreshNodes();
    if (controller.direct || state.nodes.length <= 1) {
      setTerminalTarget(null);
      setTerminalStandalone(true);
      setTerminalTui(false);
      setTerminalOpen(true);
      return;
    }
    setTerminalNodePicker(true);
  }, [state.nodes]);

  const pickTerminalNode = useCallback(
    (nodeId: string) => {
      setTerminalNodePicker(false);
      if (!controller.direct && nodeId !== state.currentNodeId) controller.switchNode(nodeId);
      setTerminalTarget(null);
      setTerminalStandalone(true);
      setTerminalTui(false);
      setTerminalOpen(true);
      setDrawerOpen(false);
    },
    [state.currentNodeId],
  );

  // A `bivy run` terminal picked from the sidebar (SessionList's runTerminals
  // rows) now carries the id of whichever node owns it — that row may not
  // belong to the currently connected node at all, since the sidebar shows
  // every node's terminals (issue #99). Attaching sends over the live
  // transport, so a cross-node pick must switch (and wait for the new node to
  // come online) before opening the overlay, the same way openSessionOnNode
  // does for chat sessions.
  const pickTerminal = useCallback(
    (termId: string, nodeId?: string) => {
      const open = () => {
        setTerminalTarget(termId);
        setTerminalStandalone(false);
        setTerminalTui(false);
        setTerminalOpen(true);
      };
      setDrawerOpen(false);
      if (!controller.direct && nodeId && nodeId !== state.currentNodeId) {
        void controller.connectToNode(nodeId).then(open).catch((err) => {
          controller.store.setError(err instanceof Error ? err.message : String(err));
        });
        return;
      }
      open();
    },
    [state.currentNodeId],
  );

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
    if (state.activeSessionId) controller.closeSessionTui(state.activeSessionId);
  }, [state.activeSessionId]);

  // Auth/setup gates, derived from reactive store fields (not read live off
  // localStorage) so signing in swaps the sign-in screen for the app shell the
  // instant the token lands — no page reload needed. `direct` (local/loopback
  // mode) never gates on a control-plane session.
  const needsAuth = !controller.direct && !state.signedIn;
  const needsNode = !controller.direct && state.signedIn && !state.currentNodeId;

  // Hosted control plane, not signed in yet: show the sign-in screen instead of a
  // dead shell. Once signed in we always render the normal app — a node is picked
  // in-place from the header NodeSwitcher, not behind a separate full-screen gate,
  // so a refresh lands on the sidebar rather than a "Choose a node" wall.
  if (needsAuth) {
    return (
      <>
        <SetupNotice />
        <div className="toast-stack">
          <NoticeToast />
          <UpdatePrompt />
        </div>
      </>
    );
  }

  const closeDrawer = () => setDrawerOpen(false);
  const activeSession = state.sessions.find((s) => s.sessionId === state.activeSessionId);
  // Every active session shows the run card (source + live status) in the band
  // above the composer; `null` for a draft (no session yet) falls back to the
  // plain GitHub pill.
  const activeRunSource = activeSession ? classifySource(activeSession.source) : null;
  // A forked session's sheet gets its own "Forked from" row. The parent's name
  // is resolved from the local session list when known; it may live on
  // another node or be gone by now, so this degrades to a bare id.
  const activeForkedFrom = activeSession?.forkedFrom
    ? { sessionId: activeSession.forkedFrom, name: state.sessions.find((s) => s.sessionId === activeSession.forkedFrom)?.name }
    : undefined;
  const activeSessionNodeId = activeSession?.nodeId || state.currentNodeId || undefined;
  const activeSessionNode = state.nodes.find((node) => node.id === activeSessionNodeId);
  const activeSessionNodeLabel = activeSessionNode
    ? `${activeSessionNode.name || activeSessionNode.id} (${activeSessionNode.id})`
    : activeSessionNodeId;
  const isRepoSession = Boolean(activeSession?.source && String(activeSession.source).startsWith("repo:"));
  // "Continue in terminal" is offered only when this session's runtime can hand
  // itself to its native TUI on the node (capability `interactiveTui`) — the
  // analog of the terminal's capability-gated "continue in chat". Absent caps
  // (older node / runtime not yet loaded) default to hidden.
  const activeRuntimeCaps = state.runtimes.find((r) => r.id === activeSession?.runtimeId)?.capabilities as
    | { interactiveTui?: boolean }
    | undefined;
  const canContinueInTerminal = online && Boolean(activeRuntimeCaps?.interactiveTui);

  // Approval/question cards render inline in the active session's chat scroll, so
  // only show the ones that belong to that session. Items are still kept globally
  // in the store (for the sidebar "needs response" indicator); we just don't render
  // another session's cards into whichever chat happens to be on screen. Items with
  // no sessionId are treated as global and shown everywhere.
  const activeApprovals = state.approvals.filter((a) => !a.sessionId || a.sessionId === state.activeSessionId);
  const activeQuestions = state.questions.filter((q) => !q.sessionId || q.sessionId === state.activeSessionId);

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
              className="icon-btn term-btn"
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
              className="ghost-btn"
              onClick={() => {
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
          onPick={(id, path, nodeId) => {
            controller.openSessionOnNode(id, path, nodeId);
            closeDrawer();
          }}
          onPickTerminal={pickTerminal}
        />
        {/* One entry point now — a ChatGPT-style gear. Theme, GitHub Queue, and
            everything else moved inside the Settings modal. */}
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
            <span className="settings-gear-label">Settings</span>
          </button>
        </div>
      </aside>

      {drawerOpen && <div className="scrim" onClick={closeDrawer} />}

      <main className={`main${needsNode ? " needs-node" : ""}`}>
        <header className="topbar">
          <button className="icon-btn only-mobile" onClick={() => setDrawerOpen(true)} aria-label="Open sessions">
            ☰
          </button>
          <div className="topbar-title">
            <div className="topbar-title-row">
              {/* Same dot/color rules as the sidebar row (see sessionStatus.ts) —
                  a session opened here should read identically whether you're
                  looking at the list or already inside it. Only rendered once a
                  real session is open; a brand-new draft has no status yet. */}
              {activeSession && (
                <span
                  className={`session-dot ${statusClass(activeSession)}${isUnseen(activeSession) ? " unseen" : ""}`}
                  title={statusLabel(activeSession)}
                  aria-hidden
                />
              )}
              <h1 className="title" title={state.activeTitle}>
                {state.activeTitle}
              </h1>
            </div>
            {/* Node stays below the title as a plain subtitle line — but it's
                still the real switcher button underneath, so it's selectable
                on a brand-new/draft session exactly as it is on a live one. */}
            {!controller.direct && <NodeSwitcher />}
          </div>
          <div className="topbar-actions">
            {state.activeSessionId && (
              <button
                className="icon-btn eye-btn"
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
            {state.activeSessionId && (
              <SessionMenu
                sessionId={state.activeSessionId}
                name={state.activeTitle}
                isRepo={isRepoSession}
                node={activeSessionNodeLabel}
                agent={activeSession?.agentName || activeSession?.runtimeId}
                workspace={activeSession?.workspace}
                worktree={activeSession?.worktree}
                branch={activeSession?.branch}
                sessionFile={activeSession?.path}
                onOpenTerminal={online ? () => { setTerminalTarget(null); setTerminalStandalone(false); setTerminalTui(false); setTerminalOpen(true); } : undefined}
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
        {(state.status === "pairing" || state.status === "linking") && (
          <div className="banner info" role="status">
            <span className="reconnect-spinner" aria-hidden />
            Linking this device…
          </div>
        )}

        {needsNode && (
          <div className="connect-runner-scroll">
            <ConnectRunner
              nodes={state.nodes}
              ephemeralEnabled={EPHEMERAL_MACHINES_ENABLED}
              onPickNode={(nodeId) => controller.switchNode(nodeId)}
              onEphemeral={() => setEphemeralOpen(true)}
              onRefresh={() => controller.refreshNodes()}
            />
          </div>
        )}

        <ChatView
          entries={state.transcript}
          working={state.working}
          workingLabel={state.workingLabel}
          // Whether there's no real session behind the current view — driven by
          // the session store rather than the URL, since the URL now moves to
          // `/settings/*` while Settings is open without changing (or clearing)
          // whatever session is open behind it.
          draftRoute={!state.activeSessionId}
          sessionKey={state.activeSessionId}
          collapsed={collapsed}
          onAction={runCommand}
          footer={
            <>
              <ApprovalStack approvals={activeApprovals} onResolve={(id, ok) => controller.resolveApproval(id, ok)} />
              <QuestionStack
                questions={activeQuestions}
                onAnswer={(id, sessionId, answers) => controller.answerQuestion(id, sessionId, answers)}
                onCancel={(id, sessionId) => controller.cancelQuestion(id, sessionId)}
              />
            </>
          }
        />

        <ChangesCard changes={state.changes} checkpoints={state.checkpoints} />

        <div className="composer-gh">
          {/* The run card now stands for every active session — an automation
              trigger, a fork, or a plain hand-opened one — carrying whatever
              applies: source, live status, token usage, fork lineage, and (in
              its sheet) the run evidence and GitHub links. Only a draft (no
              session yet) falls back to the bare GithubPill for repo context. */}
          {activeSession && activeRunSource ? (
            <RunPill
              source={activeRunSource}
              statusClass={statusClass(activeSession)}
              statusLabel={statusLabel(activeSession)}
              gh={state.github}
              evidence={runEvidence.get(activeSession.sessionId)}
              finishedAt={activeSession.finishedAt}
              usage={state.usage}
              forkedFrom={activeForkedFrom}
            />
          ) : (
            <GithubPill gh={state.github} />
          )}
          {/* Slash-command pill, pushed to the right so it sits top-right over
              the composer on the same band as the GitHub context. Tapping it
              (re)initializes a closed session so its commands can be fetched,
              then opens the composer's "/" menu. Hidden on a draft (new
              session) — there's no attached session to advertise commands yet. */}
          {state.activeSessionId && (
            <button
              type="button"
              className="slash-pill"
              onClick={() => controller.openSlashCommands()}
              disabled={!canCompose}
              title="Slash commands"
              aria-label="Slash commands"
            >
              <svg className="slash-glyph" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M11 3 5 13" />
              </svg>
            </button>
          )}
        </div>

        {activeTuiLocked && (
          <div className="composer-tui-lock" role="status">
            <span className="composer-tui-lock-text">This session is open in the terminal (TUI).</span>
            <div className="composer-tui-lock-actions">
              <button type="button" className="ghost-btn" onClick={continueInTerminal}>
                Go to terminal
              </button>
              <button type="button" className="btn primary" onClick={takeoverInChat}>
                Take over in chat
              </button>
            </div>
          </div>
        )}

        <Composer
          state={state}
          disabled={!canCompose}
          disabledHint={activeTuiLocked ? "Open in the terminal — take over to chat here" : state.status === "offline" ? "Not connected" : "Connecting…"}
          working={state.working}
          onSend={(text, attachments) => controller.sendPrompt(text, attachments)}
          onAbort={() => controller.abort()}
          onError={(message) => controller.store.setError(message)}
        />
      </main>

      {settingsRoute && (
        <Settings
          state={state}
          view={settingsRoute.view}
          onViewChange={setSettingsView}
          githubQueue={githubQueue}
          onRefreshGithubQueue={refreshGithubQueue}
          onPickSession={(id, path, nodeId) => {
            controller.openSessionOnNode(id, path, nodeId);
            // openSessionOnNode already navigates to `/sessions/:id` itself;
            // this just resolves Settings back to that same route.
            closeSettings({ kind: "session", id });
            closeDrawer();
          }}
          onImported={(id) => {
            // importNativeSession already opened + navigated to the new session
            // (with its resume ref); just dismiss Settings onto that route.
            closeSettings({ kind: "session", id });
            closeDrawer();
          }}
          onClose={() =>
            closeSettings(
              state.activeSessionId ? { kind: "session", id: state.activeSessionId } : { kind: "new" },
            )
          }
        />
      )}
      {ephemeralOpen && <EphemeralSheet onClose={() => setEphemeralOpen(false)} firstRun={needsNode} />}
      {state.needsModelAuth && <FirstRunModelAuthSheet state={state} />}
      {terminalNodePicker && (
        <NodePicker
          state={state}
          currentNodeId={state.currentNodeId}
          onPick={pickTerminalNode}
          onClose={() => setTerminalNodePicker(false)}
        />
      )}
      {terminalOpen && (
        <Suspense fallback={null}>
          <TerminalOverlay
            sessionId={terminalStandalone ? null : state.activeSessionId}
            attachTermId={terminalTarget}
            standalone={terminalStandalone}
            tui={terminalTui}
            onClose={() => {
              setTerminalOpen(false);
              setTerminalTarget(null);
              setTerminalStandalone(false);
              setTerminalTui(false);
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
