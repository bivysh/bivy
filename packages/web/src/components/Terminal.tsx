// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";
import type { RuntimeInfo, ServerEvent } from "@bivy/core";
import { controller, useAppState } from "../store/useStore.js";
import { RenameDialog } from "./AppDialog.js";
import { writeClipboard } from "../clipboard.js";
import { useModalEscape } from "../modalStack.js";

interface RunTerminal {
  termId: string;
  label?: string;
  name?: string;
  agent?: string;
  workspace?: string;
  /** Pinned agent session id (set for shim/`bivy run` launches) — enables
   *  "continue as chat" (resume this session as a governed chat). */
  sessionId?: string;
  /** Reported by the node: whether a takeover would actually find a session
   *  right now (pinned id, or a session already discovered on disk). Absent on
   *  older nodes — treated as ready to preserve prior behavior. */
  takeoverReady?: boolean;
  pid?: number;
}
interface MuxSession {
  multiplexer: string;
  name: string;
  attached?: boolean;
  target?: string;
}

// A takeover can resume even *without* a launch-time session-id pin when the
// node discovers the on-disk session by cwd + start time. Some agents (e.g.
// Codex, Pi) assign their session ids after launch, so their run-terminals
// carry no pinned `sessionId`, yet the node can still adopt them — "continue as
// chat" must not be gated on the id alone. Which agents support this is
// capability-driven: the runtime advertises `capabilities.sessionDiscovery`
// (see RuntimeCapabilities in src/runtime/types.ts). Absent capabilities (older
// node) default to false — matching how the other opt-in runtime capabilities
// are read elsewhere (e.g. Pickers.tsx `Boolean(caps.resume)`).
function canContinueAsChat(t: RunTerminal, runtimes: RuntimeInfo[]): boolean {
  if (t.sessionId) return true;
  // Match by runtime id (e.g. "grok") OR by agent alias — run-terminals store
  // the short `bivy run <agent>` name, which is usually the same as the runtime
  // id for process agents.
  const agent = String(t.agent || "");
  const runtime = runtimes.find((r) => r.id === agent || r.id === `${agent}-approvals` || r.id === `${agent}-code-sdk`);
  const caps = runtime?.capabilities as { sessionDiscovery?: boolean } | undefined;
  return Boolean(caps?.sessionDiscovery);
}

// Whether a takeover would succeed *right now*. `canContinueAsChat` says the
// agent supports takeover at all; this says its session has actually started.
// Agents that assign their id lazily (Pi, Codex) advertise the capability
// immediately but have nothing to adopt until the first message — tapping then
// used to surface a raw 409. The node reports `takeoverReady`; older nodes omit
// it, so `!== false` keeps them at prior behavior (button enabled).
function isTakeoverReady(t: RunTerminal): boolean {
  return t.takeoverReady !== false;
}

// Human-first (no "409"/"session id" jargon) — non-technical users read this on
// the mobile "Continue in chat" affordance when the agent hasn't started yet.
const TAKEOVER_NOT_READY_HINT =
  "Send a message in the terminal first — the chat starts once the conversation begins.";

const FONT_FAMILY = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
const MIN_FONT = 9;
const MAX_FONT = 26;
const DEFAULT_FONT = 13;
const FONT_KEY = "bivy.term.fontSize";

function scopeKey(sessionId: string | null): string {
  return sessionId ? `s:${sessionId}` : "node";
}
/** Last path segment, for a compact workspace label in the standalone header. */
function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed;
}
function readTheme() {
  const s = getComputedStyle(document.body);
  const v = (n: string, f: string) => s.getPropertyValue(n).trim() || f;
  return {
    background: v("--bg", "#111"),
    foreground: v("--ink", "#eee"),
    cursor: v("--ink", "#eee"),
    cursorAccent: v("--bg", "#111"),
    // A visible, semi-transparent selection tint (glyphs read through it). The
    // inactive variant keeps the highlight visible when focus leaves the grid,
    // e.g. while clicking the Copy/toolbar buttons.
    selectionBackground: v("--term-selection", "rgba(96,165,250,0.40)"),
    selectionInactiveBackground: v("--term-selection-inactive", "rgba(96,165,250,0.26)"),
  };
}
function readFontSize(): number {
  const n = Number(localStorage.getItem(FONT_KEY));
  return Number.isFinite(n) && n >= MIN_FONT && n <= MAX_FONT ? n : DEFAULT_FONT;
}

/** Coarse pointer / touch device — where we show the on-screen key accessory bar. */
function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(pointer: coarse)").matches || "ontouchstart" in window;
}

/**
 * Attach a GPU renderer, degrading gracefully: WebGL → Canvas → the built-in DOM
 * renderer. The WebGL context can also be lost at runtime (tab backgrounded on
 * mobile, GPU reset); we listen for that and fall back to Canvas so the terminal
 * never goes blank. Returns a disposer for whichever addon actually loaded.
 */
function attachRenderer(term: XTerm): () => void {
  const tryCanvas = (): (() => void) => {
    try {
      const canvas = new CanvasAddon();
      term.loadAddon(canvas);
      return () => canvas.dispose();
    } catch {
      return () => {};
    }
  };
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      try {
        webgl.dispose();
      } catch {
        /* already gone */
      }
      tryCanvas();
    });
    term.loadAddon(webgl);
    return () => {
      try {
        webgl.dispose();
      } catch {
        /* already disposed on context loss */
      }
    };
  } catch {
    return tryCanvas();
  }
}

// --- Touch geometry -------------------------------------------------------
// xterm renders to a canvas, so there's no selectable DOM text and the browser's
// native touch selection can't reach it — which is why touch selection feels
// broken. We drive it ourselves off the `.xterm-screen` box: cell size is the
// box divided by the grid, and a touch point maps to an absolute buffer cell
// (viewport-relative row + the current scrollback offset).

interface Cell {
  col: number;
  /** Absolute row index within the whole buffer (scrollback included). */
  absRow: number;
}

function screenElOf(mount: HTMLElement | null): HTMLElement | null {
  return (mount?.querySelector(".xterm-screen") as HTMLElement | null) ?? null;
}

function cellSize(term: XTerm, screen: HTMLElement): { w: number; h: number; rect: DOMRect } {
  const rect = screen.getBoundingClientRect();
  return { w: rect.width / term.cols || 1, h: rect.height / term.rows || 1, rect };
}

function pointToCell(term: XTerm, screen: HTMLElement, clientX: number, clientY: number): Cell {
  const { w, h, rect } = cellSize(term, screen);
  const col = Math.min(Math.max(Math.floor((clientX - rect.left) / w), 0), term.cols - 1);
  const row = Math.min(Math.max(Math.floor((clientY - rect.top) / h), 0), term.rows - 1);
  return { col, absRow: term.buffer.active.viewportY + row };
}

/** Word (run of non-whitespace) around `col` on an absolute buffer row. */
function wordBoundsAt(term: XTerm, absRow: number, col: number): { start: number; len: number } | null {
  const line = term.buffer.active.getLine(absRow);
  if (!line) return null;
  const str = line.translateToString(false);
  const ws = (c: string | undefined) => !c || /\s/.test(c);
  if (ws(str[col])) return { start: col, len: 1 };
  let start = col;
  while (start > 0 && !ws(str[start - 1])) start--;
  let end = col;
  while (end < str.length - 1 && !ws(str[end + 1])) end++;
  return { start, len: end - start + 1 };
}

/** Select the flowing range between two cells (anchor↔point), inclusive. */
function selectRange(term: XTerm, a: Cell, b: Cell): void {
  const cols = term.cols;
  const off1 = a.absRow * cols + a.col;
  const off2 = b.absRow * cols + b.col;
  const [lo, hi] = off1 <= off2 ? [off1, off2] : [off2, off1];
  term.select(lo % cols, Math.floor(lo / cols), hi - lo + 1);
}

/** Order two cells so start ≤ end in buffer flow (for handle placement). */
function normalizeCells(term: XTerm, a: Cell, b: Cell): { start: Cell; end: Cell } {
  const cols = term.cols;
  return a.absRow * cols + a.col <= b.absRow * cols + b.col ? { start: a, end: b } : { start: b, end: a };
}

/** Map an absolute buffer cell to a viewport pixel point, flagging off-screen. */
function cellToPoint(term: XTerm, screen: HTMLElement, cell: Cell): { x: number; y: number; w: number; h: number; visible: boolean } {
  const { w, h, rect } = cellSize(term, screen);
  const rowInView = cell.absRow - term.buffer.active.viewportY;
  return {
    x: rect.left + cell.col * w,
    y: rect.top + rowInView * h,
    w,
    h,
    visible: rowInView >= 0 && rowInView < term.rows,
  };
}

// --- Snippets & recent commands -------------------------------------------
// Typing is the tax on a phone terminal, so we let users re-run without it:
// recent commands are captured heuristically from what they type before Enter,
// and snippets are commands they explicitly save. Both are per-scope (node or
// session) in localStorage; a tap inserts the text, a long-press runs it.

interface Snippet {
  id: string;
  text: string;
}
const RECENTS_LIMIT = 20;
const recentsKey = (scope: string) => `bivy.term.recent.${scope}`;
const snippetsKey = (scope: string) => `bivy.term.snips.${scope}`;

function loadList<T>(k: string): T[] {
  try {
    const v = JSON.parse(localStorage.getItem(k) || "[]");
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
function saveList(k: string, v: unknown[]): void {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* quota / private mode — snippets are best-effort */
  }
}
function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s${Date.now().toString(36)}${Math.floor(performance.now())}`;
}

/**
 * A snippet / recent-command chip. Tap inserts the text at the prompt (safe — you
 * still press Enter); a long-press runs it outright. An optional badge (delete a
 * snippet, pin a recent) shows in the bar's edit mode.
 */
function Chip({
  label,
  title,
  onTap,
  onHold,
  badge,
}: {
  label: string;
  title?: string;
  onTap: () => void;
  onHold?: () => void;
  badge?: { label: string; aria: string; onClick: () => void };
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const cancel = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const start = () => {
    held.current = false;
    if (!onHold) return;
    timer.current = setTimeout(() => {
      held.current = true;
      onHold();
      navigator.vibrate?.(10);
    }, 450);
  };
  return (
    <span className="term-chip-wrap">
      {badge && (
        <button className="term-chip-badge" onClick={badge.onClick} aria-label={badge.aria}>
          {badge.label}
        </button>
      )}
      <button
        className="term-chip"
        title={title || (onHold ? "Tap to insert · hold to run" : undefined)}
        onMouseDown={(e) => e.preventDefault()}
        onTouchStart={start}
        onTouchEnd={cancel}
        onTouchMove={cancel}
        onClick={() => {
          if (held.current) {
            held.current = false;
            return;
          }
          onTap();
        }}
      >
        {label}
      </button>
    </span>
  );
}

export function TerminalOverlay({
  sessionId,
  attachTermId,
  standalone,
  tui,
  onClose,
}: {
  sessionId: string | null;
  attachTermId?: string | null;
  /** True for the session-less terminal opened from the sidebar's terminal
   *  button (#460): always opens at the connected node's default workspace
   *  folder, ignoring any active chat session. */
  standalone?: boolean;
  /** "Continue in terminal": instead of opening a plain shell, hand this chat
   *  session off to the runtime's interactive TUI (resumes the same
   *  conversation) via `terminal.open.tui`. Requires `sessionId`. The reverse
   *  of "continue in chat" (takeover). */
  tui?: boolean;
  onClose: () => void;
}) {
  // Runtime capabilities (e.g. `sessionDiscovery`) drive whether a run-terminal
  // with no pinned session id can still be continued as a governed chat.
  const { catalogs: { runtimes } } = useAppState();
  const mountRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const termIdRef = useRef<string | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "exited" | "error">("connecting");
  const [statusText, setStatusText] = useState("Connecting…");
  const [runTerminals, setRunTerminals] = useState<RunTerminal[]>([]);
  const [muxSessions, setMuxSessions] = useState<MuxSession[]>([]);
  // The run-terminal currently bound to this overlay, if any — lets the header
  // offer "continue as chat" when that terminal carries a pinned session id.
  const [currentTermId, setCurrentTermId] = useState<string | null>(null);
  const [showAttach, setShowAttach] = useState(false);
  const attachWrapRef = useRef<HTMLDivElement>(null);
  // Dismiss the "Attach ▾" menu on an outside tap or Escape. Escape is claimed
  // (topmost layer) so it closes the menu instead of reaching the PTY; with the
  // menu closed Escape flows to the terminal as usual.
  useModalEscape(() => setShowAttach(false), showAttach);
  useEffect(() => {
    if (!showAttach) return;
    const onDown = (e: PointerEvent) => {
      if (attachWrapRef.current && !attachWrapRef.current.contains(e.target as Node)) setShowAttach(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [showAttach]);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [fontSize, setFontSize] = useState<number>(readFontSize);
  const [hasSelection, setHasSelection] = useState(false);
  const [copied, setCopied] = useState(false);
  // Workspace folder the live/last-attached shell is rooted at, as reported by
  // the node — shown in the header for the standalone terminal so it's clear
  // which node/folder you're in when it's not implied by a chat session.
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [altArmed, setAltArmed] = useState(false);
  // Floating selection toolbar (touch): pixel position of where the finger lifted.
  const [selMenu, setSelMenu] = useState<{ x: number; y: number } | null>(null);
  // Current touch selection's endpoints (0-based buffer cells) — drives the two
  // drag handles that let you re-grab and adjust a selection.
  const [selRange, setSelRange] = useState<{ start: Cell; end: Cell } | null>(null);
  const selRangeRef = useRef(selRange);
  selRangeRef.current = selRange;
  // The pinned end of an in-progress selection drag, and the last finger point
  // (so an edge auto-scroll tick can keep extending toward it). `live` = update
  // selRange as we go, so the handles track the moving edge.
  const selDragRef = useRef<{ fixed: Cell; live: boolean } | null>(null);
  const ptRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoDirRef = useRef(0);
  // Snippets / recent-command chips (touch keyboard-avoider).
  const [showSnips, setShowSnips] = useState(false);
  const [editSnips, setEditSnips] = useState(false);
  const [addingSnippet, setAddingSnippet] = useState(false);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [recents, setRecents] = useState<string[]>([]);
  const touch = useMemo(isTouchDevice, []);
  // A run-terminal selected in the sidebar gets its own scope and is attached
  // directly; the ordinary terminal button still opens a shell scoped to chat;
  // the standalone terminal gets a scope of its own so it never reattaches to
  // (or shares recents/snippets with) a chat-scoped shell. The TUI ("continue in
  // terminal") gets a `tui:`-prefixed scope of its own too, so opening it never
  // reattaches to a plain chat-scoped shell for the same session (and vice
  // versa) — only to a still-live TUI for that session on reconnect.
  const key = attachTermId
    ? `run:${attachTermId}`
    : standalone
      ? "standalone"
      : tui && sessionId
        ? `tui:${sessionId}`
        : scopeKey(sessionId);
  // Refs so the stable input capture / gesture handlers see the live scope
  // without re-subscribing.
  const scopeRef = useRef(key);
  scopeRef.current = key;
  const lineBufRef = useRef("");

  // Load this scope's saved snippets + recents when the scope changes.
  useEffect(() => {
    setSnippets(loadList<Snippet>(snippetsKey(key)));
    setRecents(loadList<string>(recentsKey(key)));
  }, [key]);

  // Capture a plausible command from the raw input stream so it can be re-run
  // with a tap. Heuristic: accumulate printable keys, honour backspace, and flush
  // on Enter; bail on control/escape sequences (arrow-key line editing, TUIs)
  // rather than record garbage.
  const pushRecent = useCallback((cmd: string) => {
    const c = cmd.trim();
    if (c.length < 1 || c.length > 200) return;
    setRecents((prev) => {
      const next = [c, ...prev.filter((r) => r !== c)].slice(0, RECENTS_LIMIT);
      saveList(recentsKey(scopeRef.current), next);
      return next;
    });
  }, []);
  const captureInput = useCallback(
    (data: string) => {
      // Escape sequences (arrow-key line editing, function keys, mouse, a TUI's
      // input) arrive as their own chunk led by ESC — that's navigation, not a
      // replayable command, so drop the in-progress line rather than record junk.
      if (data.charCodeAt(0) === 0x1b) {
        lineBufRef.current = "";
        return;
      }
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          pushRecent(lineBufRef.current);
          lineBufRef.current = "";
        } else if (ch === "\x7f" || ch === "\b") {
          lineBufRef.current = lineBufRef.current.slice(0, -1);
        } else if (ch === "\x03" || ch === "\x15") {
          lineBufRef.current = ""; // Ctrl-C / Ctrl-U discard the line
        } else if (ch >= " ") {
          lineBufRef.current += ch;
        }
        // other control bytes: leave the buffer untouched
      }
    },
    [pushRecent],
  );

  /** Write bytes to the PTY behind the current terminal. */
  const sendInput = useCallback(
    (data: string) => {
      const id = termIdRef.current;
      if (!id) return;
      captureInput(data);
      controller.sendTerminal({ kind: "terminal.input", termId: id, data });
    },
    [captureInput],
  );

  // Stop any running edge auto-scroll.
  const stopAutoScroll = useCallback(() => {
    if (autoTimerRef.current) {
      clearInterval(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    autoDirRef.current = 0;
  }, []);

  // Extend the active selection to a pixel point: recompute the cell under it and
  // select from the pinned end to there. When the drag is `live` (word-drag or a
  // handle), mirror the range into state so the handles follow the moving edge.
  const applyDrag = useCallback((x: number, y: number) => {
    const term = termRef.current;
    const screen = screenElOf(mountRef.current);
    const drag = selDragRef.current;
    if (!term || !screen || !drag) return;
    ptRef.current = { x, y };
    const moving = pointToCell(term, screen, x, y);
    selectRange(term, drag.fixed, moving);
    if (drag.live) setSelRange(normalizeCells(term, drag.fixed, moving));
  }, []);

  // While selecting, a finger held near the top/bottom edge scrolls the terminal
  // and keeps extending the selection into the newly revealed lines — so you can
  // select past what fits on screen without a keyboard.
  const edgeAutoScroll = useCallback(
    (y: number) => {
      const screen = screenElOf(mountRef.current);
      if (!screen) return;
      const r = screen.getBoundingClientRect();
      const zone = Math.max(28, r.height * 0.14);
      const dir = y < r.top + zone ? -1 : y > r.bottom - zone ? 1 : 0;
      if (dir === autoDirRef.current) return; // no change
      stopAutoScroll();
      autoDirRef.current = dir;
      if (dir === 0) return;
      autoTimerRef.current = setInterval(() => {
        const term = termRef.current;
        if (!term || !selDragRef.current) return stopAutoScroll();
        term.scrollLines(autoDirRef.current);
        applyDrag(ptRef.current.x, ptRef.current.y);
      }, 50);
    },
    [applyDrag, stopAutoScroll],
  );

  // Begin dragging one end of the existing selection (a handle grab): pin the
  // opposite end and let the finger drive this one.
  const startHandleDrag = useCallback((which: "start" | "end", x: number, y: number) => {
    const range = selRangeRef.current;
    if (!range) return;
    selDragRef.current = { fixed: which === "start" ? range.end : range.start, live: true };
    ptRef.current = { x, y };
    setSelMenu(null);
  }, []);

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: FONT_FAMILY,
      fontSize: readFontSize(),
      lineHeight: 1.15,
      scrollback: 10000,
      allowProposedApi: true,
      allowTransparency: false,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      scrollSensitivity: 3,
      smoothScrollDuration: 0,
      theme: readTheme(),
    });

    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new ClipboardAddon());
    try {
      const unicode = new Unicode11Addon();
      term.loadAddon(unicode);
      term.unicode.activeVersion = "11";
    } catch {
      /* unicode addon optional */
    }

    if (mountRef.current) term.open(mountRef.current);
    const disposeRenderer = attachRenderer(term);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    const doFit = () => {
      // Was the viewport resting at the bottom before we refit? If so, keep it
      // pinned there afterwards. On mobile the visual viewport changes height
      // whenever the keyboard or the browser's own toolbars slide in/out; a
      // refit that doesn't re-pin leaves the newest row parked a fraction below
      // the fold, so it reads as "clipped behind the bottom toolbar". Preserve an
      // intentional scroll-up (reading history) — only re-pin when already down.
      const buf = term.buffer.active;
      const wasAtBottom = buf.viewportY >= buf.baseY;
      try {
        fit.fit();
      } catch {
        return; /* not mounted yet */
      }
      if (wasAtBottom) term.scrollToBottom();
      const id = termIdRef.current;
      const { cols, rows } = term;
      // Only tell the node when the grid actually changed — ResizeObserver and the
      // keyboard-driven layout shifts on mobile fire far more often than the cell
      // grid changes, and each resize round-trips a PTY ioctl.
      if (id && (cols !== lastSizeRef.current.cols || rows !== lastSizeRef.current.rows)) {
        lastSizeRef.current = { cols, rows };
        controller.sendTerminal({ kind: "terminal.resize", termId: id, cols, rows });
      }
    };
    const scheduleFit = () => {
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(doFit, 60);
    };

    // Copy selection automatically (desktop convenience). The Copy button and
    // Ctrl/Cmd+C give an explicit path too. Paste is wired via keybinding + the
    // toolbar. Track whether there's a live selection so the toolbar can enable
    // its Copy button.
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      setHasSelection(Boolean(sel));
      if (sel) void writeClipboard(sel);
      else {
        setSelMenu(null);
        setSelRange(null);
      }
    });

    // Intercept a few shortcuts before they reach the PTY: search, zoom, and a
    // desktop-style Ctrl/Cmd+V paste. Everything else falls through to the shell.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "f") {
        setShowSearch(true);
        return false;
      }
      if (mod && (e.key === "+" || e.key === "=")) {
        setFontSize((f) => Math.min(MAX_FONT, f + 1));
        return false;
      }
      if (mod && e.key === "-") {
        setFontSize((f) => Math.max(MIN_FONT, f - 1));
        return false;
      }
      if (mod && e.key === "0") {
        setFontSize(DEFAULT_FONT);
        return false;
      }
      if (e.metaKey && e.key === "v") {
        void navigator.clipboard?.readText?.().then((t) => t && sendInput(t)).catch(() => {});
        return false;
      }
      // Copy the selection with Cmd+C (mac) or, VS Code-style, Ctrl+C *only when
      // something is selected* — otherwise Ctrl+C must fall through as SIGINT.
      if (e.key === "c" && (e.metaKey || (e.ctrlKey && term.hasSelection()))) {
        const sel = term.getSelection();
        if (sel) {
          void writeClipboard(sel);
          return false;
        }
      }
      return true;
    });

    term.onData((data) => sendInput(data));

    // Terminal bell → a brief visual flash so a present user notices. When you're
    // away, the node escalates the same bell to a call-me-back push (src/server.ts).
    const bellDispose = term.onBell(() => {
      const el = mountRef.current;
      if (!el) return;
      el.classList.add("term-bell-flash");
      window.setTimeout(() => el.classList.remove("term-bell-flash"), 220);
    });

    // --- Touch gestures ----------------------------------------------------
    // One finger: a long-press selects the word under it, then a drag extends the
    // selection (xterm's canvas has no selectable DOM, so we drive selection off
    // the buffer). A plain one-finger drag scrolls the grid — we drive that
    // ourselves too (see below) rather than lean on xterm's native viewport
    // scroll, which on mobile is unreliable: the GPU renderer's canvas sits over
    // the scrollable viewport, so touches often don't reach it and momentum
    // fights our gesture handling, making the grid jump or scroll the *wrong
    // way*. Two fingers: a trackpad — panning nudges the cursor with arrow keys
    // so you can position it mid-command without hunting for the arrow bar.
    type Mode = "none" | "pending" | "scrolling" | "selecting" | "cursor";
    let mode: Mode = "none";
    let lp: ReturnType<typeof setTimeout> | null = null;
    let startX = 0, startY = 0, lastX = 0, lastY = 0;
    let cw = 8, chRow = 16;
    let midX = 0, midY = 0, startDist = 0, accX = 0, accY = 0;
    // One-finger scroll bookkeeping: fractional rows not yet applied, the last
    // move's timestamp, the running velocity (rows/ms) and the flick-momentum
    // rAF handle.
    let scrollAcc = 0, lastMoveT = 0, velRows = 0;
    let momentumRAF: number | null = null;
    const clearLp = () => { if (lp) { clearTimeout(lp); lp = null; } };
    const dist2 = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const stopMomentum = () => {
      if (momentumRAF != null) { cancelAnimationFrame(momentumRAF); momentumRAF = null; }
      velRows = 0;
    };
    // Apply a signed row delta to the grid, carrying the fractional remainder so
    // slow drags still move smoothly a whole row at a time.
    const scrollByRows = (rows: number) => {
      scrollAcc += rows;
      const whole = Math.trunc(scrollAcc);
      if (whole !== 0) {
        term.scrollLines(whole);
        scrollAcc -= whole;
      }
    };
    // A flick keeps scrolling after the finger lifts, decaying with friction —
    // the momentum that makes a native list feel alive.
    const startMomentum = () => {
      if (Math.abs(velRows) < 0.004) return; // too slow to be a flick
      let v = velRows;
      let prev = performance.now();
      const step = () => {
        const t = performance.now();
        const dt = Math.min(t - prev, 32); // clamp so a stalled frame can't leap
        prev = t;
        scrollByRows(v * dt);
        v *= Math.pow(0.94, dt / 16); // ~0.94 per 16ms frame
        momentumRAF = Math.abs(v) > 0.004 ? requestAnimationFrame(step) : null;
      };
      momentumRAF = requestAnimationFrame(step);
    };

    const onTouchStart = (e: TouchEvent) => {
      // A fresh touch on the grid (not a handle — those live outside term-out and
      // never reach here) halts any flick, dismisses any existing selection and
      // its handles.
      stopMomentum();
      setSelMenu(null);
      stopAutoScroll();
      term.clearSelection();
      const screen = screenElOf(mountRef.current);
      if (!screen) return;
      const cs = cellSize(term, screen);
      cw = cs.w;
      chRow = cs.h;
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      if (t0 && t1) {
        mode = "cursor";
        midX = (t0.clientX + t1.clientX) / 2;
        midY = (t0.clientY + t1.clientY) / 2;
        startDist = dist2(t0, t1);
        accX = accY = 0;
        e.preventDefault();
        return;
      }
      if (!t0) return;
      startX = lastX = t0.clientX;
      startY = lastY = t0.clientY;
      scrollAcc = 0;
      velRows = 0;
      lastMoveT = performance.now();
      mode = "pending";
      clearLp();
      lp = setTimeout(() => {
        if (mode !== "pending") return;
        const cell = pointToCell(term, screen, lastX, lastY);
        const wb = wordBoundsAt(term, cell.absRow, cell.col);
        const startCell: Cell = wb ? { col: wb.start, absRow: cell.absRow } : cell;
        const endCell: Cell = wb ? { col: wb.start + wb.len - 1, absRow: cell.absRow } : cell;
        term.select(startCell.col, startCell.absRow, wb ? wb.len : 1);
        selDragRef.current = { fixed: startCell, live: true };
        setSelRange({ start: startCell, end: endCell });
        mode = "selecting";
        navigator.vibrate?.(10);
      }, 420);
    };

    const onTouchMove = (e: TouchEvent) => {
      const screen = screenElOf(mountRef.current);
      if (!screen) return;
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      if (mode === "cursor" && t0 && t1) {
        const nx = (t0.clientX + t1.clientX) / 2;
        const ny = (t0.clientY + t1.clientY) / 2;
        // A clear spread/pinch isn't a cursor pan — swallow it (leaves room for a
        // future pinch-to-zoom) but don't move the cursor.
        if (Math.abs(dist2(t0, t1) - startDist) > 24) {
          midX = nx;
          midY = ny;
          e.preventDefault();
          return;
        }
        accX += nx - midX;
        accY += ny - midY;
        midX = nx;
        midY = ny;
        while (accX >= cw) { sendInput("\x1b[C"); accX -= cw; }
        while (accX <= -cw) { sendInput("\x1b[D"); accX += cw; }
        while (accY >= chRow) { sendInput("\x1b[B"); accY -= chRow; }
        while (accY <= -chRow) { sendInput("\x1b[A"); accY += chRow; }
        e.preventDefault();
        return;
      }
      if (!t0) return;
      const x = t0.clientX, y = t0.clientY;
      if (mode === "pending") {
        // Once the finger travels past a small slop, decide: it's a scroll.
        // (A long-press that beat us here already switched to "selecting".)
        if (Math.hypot(x - startX, y - startY) > 8) {
          clearLp();
          mode = "scrolling";
          lastMoveT = performance.now();
          velRows = 0;
        }
        lastX = x;
        lastY = y;
      } else if (mode === "scrolling") {
        e.preventDefault();
        // Content follows the finger: drag down → reveal earlier lines (scroll
        // up). One row of finger travel == one row of scroll, so it tracks 1:1.
        const dRows = -(y - lastY) / (chRow || 16);
        scrollByRows(dRows);
        const t = performance.now();
        const dt = t - lastMoveT;
        if (dt > 0) velRows = dRows / dt; // rows/ms, for the release flick
        lastMoveT = t;
        lastX = x;
        lastY = y;
      } else if (mode === "selecting") {
        lastX = x;
        lastY = y;
        applyDrag(x, y);
        edgeAutoScroll(y);
        e.preventDefault();
      }
    };

    const onTouchEnd = () => {
      clearLp();
      stopAutoScroll();
      if (mode === "selecting" && term.hasSelection()) setSelMenu({ x: lastX, y: lastY });
      else if (mode === "scrolling") startMomentum();
      selDragRef.current = null;
      mode = "none";
    };

    const mountEl = mountRef.current;
    if (touch && mountEl) {
      mountEl.addEventListener("touchstart", onTouchStart, { passive: false });
      mountEl.addEventListener("touchmove", onTouchMove, { passive: false });
      mountEl.addEventListener("touchend", onTouchEnd);
      mountEl.addEventListener("touchcancel", onTouchEnd);
    }

    const openFresh = () => {
      requestAnimationFrame(() => {
        doFit();
        // "Continue in terminal": launch the runtime's interactive TUI resuming
        // this session (single-writer: chat is refused until the TUI exits). The
        // node re-launches/resumes on this path too, so a reconnect that lost the
        // PTY reopens the same conversation rather than a bare shell.
        if (tui && sessionId) {
          controller.sendTerminal({ kind: "terminal.open.tui", sessionId, cols: term.cols, rows: term.rows });
          return;
        }
        controller.sendTerminal({
          kind: "terminal.open",
          sessionId: sessionId || undefined,
          standalone: standalone || undefined,
          cols: term.cols,
          rows: term.rows,
        });
      });
    };

    // Reattach to a shell we opened before (per scope), else open a fresh one.
    const stored = attachTermId || sessionStorage.getItem(`bivy.next.term.${key}`);
    requestAnimationFrame(() => {
      doFit();
      if (stored) {
        termIdRef.current = stored;
        controller.sendTerminal({ kind: "terminal.attach", termId: stored, cols: term.cols, rows: term.rows });
      } else {
        openFresh();
      }
    });

    // Populate the attach lists.
    controller.sendTerminal({ kind: "terminal.list" });
    controller.sendTerminal({ kind: "terminal.multiplexers" });

    const connected = () => {
      setStatus("connected");
      setStatusText("Connected");
    };

    // Surface a one-time notice on the terminal when a dropped socket comes back,
    // and re-attach so the PTY stream resumes. The terminal multiplexes over the
    // shared app socket; when that drops (node restart after `bivy update`, a
    // network blip) output goes silent with no terminal.* event to react to — so
    // we watch the transport status instead. The notice is deferred until the
    // re-attach lands, because terminal.attached resets the screen (and
    // terminal.gone reopens a fresh shell), either of which would wipe a line
    // written now.
    let awaitingReconnect = false;
    const noteReconnected = () => {
      if (!awaitingReconnect) return;
      awaitingReconnect = false;
      term.write("\r\n\x1b[32m« reconnected »\x1b[0m\r\n");
    };
    let prevStatus = controller.store.getState().connection.status;
    const offStatus = controller.store.subscribe(() => {
      const s = controller.store.getState().connection.status;
      // Only a drop→online transition is a reconnect; the initial connecting→online
      // must not print the notice or double the first attach.
      if (s === "online" && (prevStatus === "reconnecting" || prevStatus === "offline")) {
        awaitingReconnect = true;
        const id = termIdRef.current;
        if (id) controller.sendTerminal({ kind: "terminal.attach", termId: id, cols: term.cols, rows: term.rows });
        else openFresh();
      }
      prevStatus = s;
    });

    const off = controller.onTerminal((e: ServerEvent) => {
      const p = e as any;
      switch (String(e.type)) {
        case "terminal.opened":
          termIdRef.current = p.termId;
          setCurrentTermId(p.termId);
          setWorkspace(typeof p.workspace === "string" ? p.workspace : null);
          sessionStorage.setItem(`bivy.next.term.${key}`, p.termId);
          connected();
          noteReconnected();
          lastSizeRef.current = { cols: 0, rows: 0 };
          doFit();
          term.focus();
          break;
        case "terminal.attached":
          termIdRef.current = p.termId;
          setCurrentTermId(p.termId);
          term.reset();
          if (p.data) term.write(p.data);
          connected();
          noteReconnected();
          lastSizeRef.current = { cols: 0, rows: 0 };
          doFit();
          term.focus();
          break;
        case "terminal.takeover.result":
          if (p.ok && p.sessionId) {
            // The pinned session is now a governed chat; switch to it and close
            // the terminal overlay. (The node also broadcasts session.created.)
            controller.openSession(String(p.sessionId));
            onClose();
          } else {
            term.write(`\r\n\x1b[31m${p.error || "Continue in chat failed"}\x1b[0m\r\n`);
          }
          break;
        case "terminal.output":
          if (p.termId === termIdRef.current) term.write(p.data ?? "");
          break;
        case "terminal.exit":
          term.write(`\r\n\x1b[90m[process exited: ${p.code ?? 0}]\x1b[0m\r\n`);
          sessionStorage.removeItem(`bivy.next.term.${key}`);
          termIdRef.current = null;
          setCurrentTermId(null);
          setStatus("exited");
          setStatusText("Exited");
          break;
        case "terminal.error":
          term.write(`\r\n\x1b[31m${p.error || "terminal error"}\x1b[0m\r\n`);
          setStatus("error");
          setStatusText("Error");
          break;
        case "terminal.gone":
          sessionStorage.removeItem(`bivy.next.term.${key}`);
          termIdRef.current = null;
          setCurrentTermId(null);
          openFresh();
          break;
        case "terminal.list":
          setRunTerminals(Array.isArray(p.terminals) ? p.terminals : []);
          break;
        case "multiplexer.list":
          setMuxSessions(Array.isArray(p.sessions) ? p.sessions : []);
          break;
      }
    });

    const ro = new ResizeObserver(scheduleFit);
    if (mountRef.current) ro.observe(mountRef.current);
    window.addEventListener("resize", scheduleFit);
    // The mobile virtual keyboard resizes the visual viewport without firing a
    // window resize — react to it so the grid re-fits above the keyboard. iOS
    // Safari also collapses/expands its bottom toolbar on *scroll* (not resize),
    // which changes the visible height too, so refit on both.
    window.visualViewport?.addEventListener("resize", scheduleFit);
    window.visualViewport?.addEventListener("scroll", scheduleFit);
    // Focusing/blurring the grid raises/dismisses the on-screen keyboard, which
    // is the biggest height change of all — refit (and re-pin to the bottom) so
    // the last line never ends up hidden under the keybar when focus leaves.
    const ta = term.textarea;
    ta?.addEventListener("focus", scheduleFit);
    ta?.addEventListener("blur", scheduleFit);

    return () => {
      off();
      offStatus();
      ro.disconnect();
      window.removeEventListener("resize", scheduleFit);
      window.visualViewport?.removeEventListener("resize", scheduleFit);
      window.visualViewport?.removeEventListener("scroll", scheduleFit);
      ta?.removeEventListener("focus", scheduleFit);
      ta?.removeEventListener("blur", scheduleFit);
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      clearLp();
      stopMomentum();
      stopAutoScroll();
      bellDispose.dispose();
      if (touch && mountEl) {
        mountEl.removeEventListener("touchstart", onTouchStart);
        mountEl.removeEventListener("touchmove", onTouchMove);
        mountEl.removeEventListener("touchend", onTouchEnd);
        mountEl.removeEventListener("touchcancel", onTouchEnd);
      }
      disposeRenderer();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Apply font-size changes to the live terminal, persist, and re-fit.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    localStorage.setItem(FONT_KEY, String(fontSize));
    try {
      fitRef.current?.fit();
    } catch {
      /* noop */
    }
    const id = termIdRef.current;
    if (id) {
      lastSizeRef.current = { cols: term.cols, rows: term.rows };
      controller.sendTerminal({ kind: "terminal.resize", termId: id, cols: term.cols, rows: term.rows });
    }
  }, [fontSize]);

  // Run the search whenever the query changes (incremental find).
  useEffect(() => {
    if (!showSearch) return;
    if (searchQuery) searchRef.current?.findNext(searchQuery, { incremental: true });
  }, [searchQuery, showSearch]);

  const attachRun = (t: RunTerminal) => {
    termIdRef.current = t.termId;
    sessionStorage.setItem(`bivy.next.term.${key}`, t.termId);
    const term = termRef.current!;
    lastSizeRef.current = { cols: 0, rows: 0 };
    controller.sendTerminal({ kind: "terminal.attach", termId: t.termId, cols: term.cols, rows: term.rows });
    setShowAttach(false);
  };
  const attachMux = (s: MuxSession) => {
    const term = termRef.current!;
    termIdRef.current = null;
    controller.sendTerminal({ kind: "terminal.open.mux", agent: s.multiplexer, label: s.name, cols: term.cols, rows: term.rows });
    setShowAttach(false);
  };

  const endShell = () => {
    const id = termIdRef.current;
    if (id) controller.sendTerminal({ kind: "terminal.close", termId: id });
    sessionStorage.removeItem(`bivy.next.term.${key}`);
    termIdRef.current = null;
    onClose();
  };

  // "Continue in chat": stop this run-terminal's native TUI and reopen its pinned
  // session as a governed chat. The node acks with terminal.takeover.result
  // (handled above), which switches the app to the new chat session.
  const continueAsChat = (termId: string) => {
    controller.sendTerminal({ kind: "terminal.takeover", termId });
    setShowAttach(false);
  };
  // The run-terminal bound to this overlay. It can graduate to a chat when it
  // carries a pinned session id (shim/`bivy run` launches) or its agent's
  // session is discoverable on disk by the node (Codex) — see canContinueAsChat.
  const currentRun = runTerminals.find((t) => t.termId === currentTermId);

  const copySelection = () => {
    const sel = termRef.current?.getSelection();
    if (!sel) return;
    void writeClipboard(sel).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }
    });
  };
  const clearScreen = () => {
    termRef.current?.clear();
    termRef.current?.focus();
  };
  const pasteFromClipboard = () => {
    void navigator.clipboard?.readText?.().then((t) => {
      if (t) sendInput(t);
      termRef.current?.focus();
    }).catch(() => {});
  };

  // --- Snippet / recent-chip actions --------------------------------------
  const insertChip = (text: string) => {
    sendInput(text);
    termRef.current?.focus();
  };
  const runChip = (text: string) => {
    sendInput(text.endsWith("\n") ? text : `${text}\r`);
    termRef.current?.focus();
  };
  const saveSnippet = (text: string) => {
    setSnippets((prev) => {
      if (prev.some((s) => s.text === text)) return prev;
      const next = [...prev, { id: newId(), text }];
      saveList(snippetsKey(key), next);
      return next;
    });
    setAddingSnippet(false);
  };
  const addSnippet = () => setAddingSnippet(true);
  const pinRecent = (text: string) => {
    setSnippets((prev) => {
      if (prev.some((s) => s.text === text)) return prev;
      const next = [...prev, { id: newId(), text }];
      saveList(snippetsKey(key), next);
      return next;
    });
  };
  const removeSnippet = (id: string) => {
    setSnippets((prev) => {
      const next = prev.filter((s) => s.id !== id);
      saveList(snippetsKey(key), next);
      return next;
    });
  };
  const clearRecents = () => {
    setRecents([]);
    saveList(recentsKey(key), []);
  };

  // --- Floating selection-toolbar actions (touch) -------------------------
  const menuCopy = () => {
    copySelection();
    setSelMenu(null);
  };
  const menuPaste = () => {
    pasteFromClipboard();
    setSelMenu(null);
  };
  const menuSelectAll = () => {
    termRef.current?.selectAll();
    setSelRange(null); // whole-buffer selection: handles at the extremes aren't useful
  };
  const menuClearSel = () => {
    termRef.current?.clearSelection();
    setSelMenu(null);
    termRef.current?.focus();
  };

  const hasChips = snippets.length > 0 || recents.length > 0;

  // --- On-screen key accessory bar (touch) --------------------------------
  // Ctrl / Alt act as one-shot sticky modifiers: arm them, then the next key
  // (a bar key or a keyboard key) is sent with that modifier applied.
  const sendKey = useCallback(
    (raw: string, opts?: { ctrl?: boolean; literal?: boolean }) => {
      let out = raw;
      const applyCtrl = ctrlArmed || opts?.ctrl;
      if (applyCtrl && !opts?.literal && raw.length === 1) {
        const code = raw.toLowerCase().charCodeAt(0);
        if (code >= 97 && code <= 122) out = String.fromCharCode(code - 96); // a→\x01 … z→\x1a
      }
      if (altArmed && !opts?.literal) out = `\x1b${out}`;
      sendInput(out);
      setCtrlArmed(false);
      setAltArmed(false);
      termRef.current?.focus();
    },
    [ctrlArmed, altArmed, sendInput],
  );

  const barKeys: Array<{ label: string; run: () => void; active?: boolean; wide?: boolean }> = [
    { label: "esc", run: () => sendKey("\x1b", { literal: true }) },
    { label: "tab", run: () => sendKey("\t", { literal: true }) },
    { label: "ctrl", run: () => setCtrlArmed((v) => !v), active: ctrlArmed },
    { label: "alt", run: () => setAltArmed((v) => !v), active: altArmed },
    { label: "▲", run: () => sendKey("\x1b[A", { literal: true }) },
    { label: "▼", run: () => sendKey("\x1b[B", { literal: true }) },
    { label: "◀", run: () => sendKey("\x1b[D", { literal: true }) },
    { label: "▶", run: () => sendKey("\x1b[C", { literal: true }) },
    { label: "^C", run: () => sendKey("\x03", { literal: true }) },
    { label: "^D", run: () => sendKey("\x04", { literal: true }) },
    { label: "^Z", run: () => sendKey("\x1a", { literal: true }) },
    { label: "^L", run: () => sendKey("\x0c", { literal: true }) },
    { label: "~", run: () => sendKey("~", { literal: true }) },
    { label: "/", run: () => sendKey("/", { literal: true }) },
    { label: "-", run: () => sendKey("-", { literal: true }) },
    { label: "|", run: () => sendKey("|", { literal: true }) },
    { label: "home", run: () => sendKey("\x1b[H", { literal: true }) },
    { label: "end", run: () => sendKey("\x1b[F", { literal: true }) },
  ];

  const hasAttachables = runTerminals.length > 0 || muxSessions.length > 0;

  return (
    <div className="term-overlay">
      <div className="term-head">
        <span className="term-title">
          Terminal
          {standalone && workspace && (
            <small className="term-scope" title={workspace}>
              {" "}
              · {baseName(workspace)}
            </small>
          )}{" "}
          <small className={`term-status term-status-${status}`}>{statusText}</small>
        </span>
        <div className="term-head-actions">
          <div className="term-zoom" role="group" aria-label="Font size">
            <button className="icon-btn" onClick={() => setFontSize((f) => Math.max(MIN_FONT, f - 1))} aria-label="Decrease font size" title="Zoom out">
              A−
            </button>
            <button className="icon-btn" onClick={() => setFontSize((f) => Math.min(MAX_FONT, f + 1))} aria-label="Increase font size" title="Zoom in">
              A+
            </button>
          </div>
          <button className={`ghost-btn${showSearch ? " is-active" : ""}`} onClick={() => setShowSearch((v) => !v)} title="Search (Ctrl/Cmd+F)">
            Search
          </button>
          <button className="ghost-btn" onClick={copySelection} disabled={!hasSelection} title="Copy selection (Cmd/Ctrl+C)">
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="ghost-btn" onClick={clearScreen} title="Clear screen">
            Clear
          </button>
          <button className="ghost-btn term-paste" onClick={pasteFromClipboard} title="Paste from clipboard">
            Paste
          </button>
          {touch && (
            <button className={`ghost-btn${showSnips ? " is-active" : ""}`} onClick={() => setShowSnips((v) => !v)} title="Snippets & recent commands">
              Snippets
            </button>
          )}
          {hasAttachables && (
            <div className="term-attach-wrap" ref={attachWrapRef}>
              <button className="ghost-btn" onClick={() => setShowAttach((v) => !v)} aria-haspopup="menu" aria-expanded={showAttach}>
                Attach ▾
              </button>
              {showAttach && (
                <div className="term-attach-menu">
                  {runTerminals.map((t) => (
                    <div key={t.termId} className="term-attach-row">
                      <button className="term-attach-item" onClick={() => attachRun(t)}>
                        {t.label || t.name || t.agent || t.termId}
                      </button>
                      {canContinueAsChat(t, runtimes) && (
                        isTakeoverReady(t) ? (
                          <button
                            className="term-attach-chat"
                            onClick={() => continueAsChat(t.termId)}
                            title="Stop the terminal and continue this session as a governed chat"
                          >
                            Continue in chat
                          </button>
                        ) : (
                          <button
                            className="term-attach-chat is-disabled"
                            disabled
                            aria-disabled="true"
                            title={TAKEOVER_NOT_READY_HINT}
                          >
                            Send a message first
                          </button>
                        )
                      )}
                    </div>
                  ))}
                  {muxSessions.map((s) => (
                    <button key={s.target || `${s.multiplexer}:${s.name}`} className="term-attach-item" onClick={() => attachMux(s)}>
                      {s.multiplexer}: {s.name}
                      {s.attached ? " · in use" : ""}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {currentRun && canContinueAsChat(currentRun, runtimes) && (
            isTakeoverReady(currentRun) ? (
              <button
                className="btn primary term-continue-chat"
                onClick={() => continueAsChat(currentRun.termId)}
                title="Stop the terminal and continue this session as a governed chat"
              >
                Continue in chat
              </button>
            ) : (
              <span className="term-continue-notready" title={TAKEOVER_NOT_READY_HINT}>
                <button className="btn primary term-continue-chat" disabled aria-disabled="true">
                  Continue in chat
                </button>
                <span className="term-continue-hint-text">Send a message first</span>
              </span>
            )
          )}
          <button className="ghost-btn" onClick={endShell}>
            End
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="Close terminal">
            ×
          </button>
        </div>
      </div>

      {showSearch && (
        <div className="term-search">
          <input
            className="term-search-input"
            autoFocus
            placeholder="Search output…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) searchRef.current?.findPrevious(searchQuery);
                else searchRef.current?.findNext(searchQuery);
              } else if (e.key === "Escape") {
                setShowSearch(false);
                termRef.current?.focus();
              }
            }}
          />
          <button className="icon-btn" onClick={() => searchRef.current?.findPrevious(searchQuery)} aria-label="Previous match" title="Previous (Shift+Enter)">
            ↑
          </button>
          <button className="icon-btn" onClick={() => searchRef.current?.findNext(searchQuery)} aria-label="Next match" title="Next (Enter)">
            ↓
          </button>
          <button className="icon-btn" onClick={() => { setShowSearch(false); termRef.current?.focus(); }} aria-label="Close search">
            ×
          </button>
        </div>
      )}

      <div className="term-out" ref={mountRef} />

      {selMenu && (
        <div
          className="term-selmenu"
          role="menu"
          aria-label="Selection actions"
          style={{
            left: Math.min(Math.max(selMenu.x - 96, 8), Math.max(8, window.innerWidth - 200)),
            top: Math.max(selMenu.y - 52, 8),
          }}
          // Don't let a tap on the menu clear the selection / dismiss it.
          onMouseDown={(e) => e.preventDefault()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <button className="term-selmenu-item" onClick={menuCopy}>Copy</button>
          <button className="term-selmenu-item" onClick={menuPaste}>Paste</button>
          <button className="term-selmenu-item" onClick={menuSelectAll}>All</button>
          <button className="term-selmenu-item" onClick={menuClearSel}>Clear</button>
        </div>
      )}

      {touch && selRange && (() => {
        const term = termRef.current;
        const screen = screenElOf(mountRef.current);
        if (!term || !screen) return null;
        const handle = (which: "start" | "end", cell: Cell, trailing: boolean) => {
          const p = cellToPoint(term, screen, cell);
          if (!p.visible) return null; // that end is scrolled out of view
          return (
            <button
              key={which}
              className={`term-selhandle term-selhandle-${which}`}
              aria-label={`Adjust selection ${which}`}
              style={{ left: p.x + (trailing ? p.w : 0), top: p.y + (trailing ? p.h : 0) }}
              onTouchStart={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const t = ev.touches[0];
                if (t) startHandleDrag(which, t.clientX, t.clientY);
              }}
              onTouchMove={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const t = ev.touches[0];
                if (!t) return;
                applyDrag(t.clientX, t.clientY);
                edgeAutoScroll(t.clientY);
              }}
              onTouchEnd={(ev) => {
                ev.stopPropagation();
                stopAutoScroll();
                selDragRef.current = null;
                setSelMenu({ x: ptRef.current.x, y: ptRef.current.y });
              }}
            />
          );
        };
        return (
          <>
            {handle("start", selRange.start, false)}
            {handle("end", selRange.end, true)}
          </>
        );
      })()}

      {touch && showSnips && (
        <div className="term-snipbar" role="toolbar" aria-label="Snippets and recent commands">
          <button className="term-snip-add" onClick={addSnippet} aria-label="Save a snippet" title="Save a command snippet">
            ＋
          </button>
          {snippets.map((s) => (
            <Chip
              key={s.id}
              label={`★ ${s.text}`}
              onTap={() => insertChip(s.text)}
              onHold={() => runChip(s.text)}
              badge={editSnips ? { label: "×", aria: `Delete snippet ${s.text}`, onClick: () => removeSnippet(s.id) } : undefined}
            />
          ))}
          {recents.map((r) => (
            <Chip
              key={`r:${r}`}
              label={r}
              onTap={() => insertChip(r)}
              onHold={() => runChip(r)}
              badge={editSnips ? { label: "★", aria: `Pin ${r} as snippet`, onClick: () => pinRecent(r) } : undefined}
            />
          ))}
          {hasChips && (
            <button className="term-snip-edit" onClick={() => setEditSnips((v) => !v)}>
              {editSnips ? "Done" : "Edit"}
            </button>
          )}
          {editSnips && recents.length > 0 && (
            <button className="term-snip-edit" onClick={clearRecents}>Clear recents</button>
          )}
        </div>
      )}

      {addingSnippet && (
        <RenameDialog
          title="Save command snippet"
          initialValue=""
          onCancel={() => setAddingSnippet(false)}
          onSave={saveSnippet}
        />
      )}

      {touch && (
        <div className="term-keybar" role="toolbar" aria-label="Terminal keys">
          {barKeys.map((k) => (
            <button
              key={k.label}
              className={`term-key${k.active ? " is-armed" : ""}`}
              // Keep focus in the terminal so the OS keyboard doesn't dismiss.
              onMouseDown={(e) => e.preventDefault()}
              onClick={k.run}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
