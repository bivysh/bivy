// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// A widget an agent placed in its message: a small web page that runs inside
// the chat — a form, a picker, a checklist, a live view — and can answer back.
//
//   ::view{src=widgets/poll.html}                        a page in the workspace
//   ```bivy {"type":"widget","url":"widgets/poll.html","data":{…}}```
//   ```bivy {"type":"widget","html":"<button>…</button>"}```   small and inline
//
// The page runs in /widget-frame.html, in an opaque origin (see that file), so
// it cannot read anything of the app's. Everything it can do goes through
// widgets/host.ts — a row in its table — and every effect is decided here:
// a message is sent only when the person actually used the widget, links open
// in a new tab, state is saved on the session's machine.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AttachmentRef } from "@bivy/core";

import { controller } from "../store/useStore.js";
import { packagedOrigin } from "../packaged-client.js";
import { resolvedTheme } from "../theme.js";
import { MAX_INLINE_HEIGHT, WidgetHost, WidgetRefusal, widgetStyleVariables, type DisplayMode, type JsonRpcMessage } from "../widgets/host.js";
import { widgetKey } from "../widgets/key.js";

/** A widget is one self-contained page; libraries come from a CDN. */
export const MAX_WIDGET_BYTES = 2 * 1024 * 1024;
const DEFAULT_HEIGHT = 120;
/** One message per widget per this many ms: a click, not a loop. */
const MESSAGE_INTERVAL_MS = 1000;

type Source =
  | { state: "loading" }
  | { state: "ready"; html: string; source: string }
  | { state: "error"; reason: string };

function decodeBase64Utf8(data: string): string {
  const binary = atob(data);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** Saved widget state per session, fetched once per session per page load. */
const savedStates = new Map<string, Promise<Record<string, { state?: unknown }>>>();
function loadStates(sessionId: string): Promise<Record<string, { state?: unknown }>> {
  let pending = savedStates.get(sessionId);
  if (!pending) {
    pending = controller
      .widgetCommand("widgets.state.get", sessionId)
      .then((reply) => ((reply as { states?: Record<string, { state?: unknown }> }).states ?? {}))
      .catch(() => ({}));
    savedStates.set(sessionId, pending);
  }
  return pending;
}

function frameUrl(): string {
  return new URL("/widget-frame.html", packagedOrigin ?? location.origin).href;
}

function currentStyles(): Record<string, string> {
  const computed = getComputedStyle(document.documentElement);
  return widgetStyleVariables((name) => computed.getPropertyValue(name));
}

export interface WidgetProps {
  /** The spec, for a fenced widget; null for `::view{src=…}`. */
  spec: Record<string, unknown> | null;
  /** The workspace page, once the node has stored it. */
  attachment: AttachmentRef | null;
  /** The workspace path the agent wrote, for naming it. */
  path: string | null;
  attrs: Record<string, string | true>;
  sessionId: string | null;
  /** The message is still streaming: the page may not be complete yet. */
  streaming?: boolean;
}

export function Widget({ spec, attachment, path, attrs, sessionId, streaming }: WidgetProps) {
  const inline = typeof spec?.html === "string" ? spec.html : null;
  const data = useMemo(() => (spec?.data && typeof spec.data === "object" && !Array.isArray(spec.data) ? (spec.data as Record<string, unknown>) : {}), [spec]);
  const title = (typeof attrs.caption === "string" && attrs.caption) || (typeof spec?.title === "string" && spec.title) || path || "Widget";
  const caption = typeof attrs.caption === "string" ? attrs.caption : typeof spec?.caption === "string" ? spec.caption : undefined;
  const declaredHeight = Number(attrs.height ?? spec?.height) || DEFAULT_HEIGHT;

  const [source, setSource] = useState<Source>({ state: "loading" });
  useEffect(() => {
    if (inline !== null) {
      setSource({ state: "ready", html: inline, source: inline });
      return;
    }
    if (!attachment) {
      setSource({ state: "loading" });
      return;
    }
    if (attachment.size > MAX_WIDGET_BYTES) {
      setSource({ state: "error", reason: "This widget is too large to run here." });
      return;
    }
    let cancelled = false;
    void controller.fetchAttachment(attachment.hash).then(
      (res) => {
        if (cancelled) return;
        if (!res) return setSource({ state: "error", reason: "This widget could not be read." });
        try {
          setSource({ state: "ready", html: decodeBase64Utf8(res.data), source: path ?? attachment.hash });
        } catch {
          setSource({ state: "error", reason: "This widget could not be read." });
        }
      },
      () => !cancelled && setSource({ state: "error", reason: "This widget could not be read." }),
    );
    return () => {
      cancelled = true;
    };
  }, [inline, attachment, path]);

  const key = useMemo(
    () => (source.state === "ready" ? widgetKey({ id: attrs.id ?? spec?.id, source: source.source, data }) : null),
    [source, attrs.id, spec?.id, data],
  );

  // Saved state is part of what the widget starts with, so the frame waits for it.
  const [saved, setSaved] = useState<{ key: string; state: unknown } | null>(null);
  useEffect(() => {
    if (!key) return;
    if (!sessionId) {
      setSaved({ key, state: null });
      return;
    }
    let cancelled = false;
    void loadStates(sessionId).then((states) => !cancelled && setSaved({ key, state: states[key]?.state ?? null }));
    return () => {
      cancelled = true;
    };
  }, [key, sessionId]);

  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(declaredHeight);
  const [mode, setMode] = useState<DisplayMode>("inline");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const stateRef = useRef<unknown>(null);
  const lastMessage = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);

  const ready = source.state === "ready" && saved !== null && saved.key === key && !streaming;
  const host = useMemo(() => {
    if (!ready || source.state !== "ready" || !key) return null;
    stateRef.current = saved!.state;
    const post = (message: JsonRpcMessage) => frame.current?.contentWindow?.postMessage(message, "*");
    return new WidgetHost({
      post,
      html: source.html,
      data,
      context: () => ({
        theme: resolvedTheme(),
        displayMode: modeRef.current,
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions: { maxHeight: modeRef.current === "inline" ? MAX_INLINE_HEIGHT : undefined },
        locale: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        platform: matchMedia("(pointer: coarse)").matches ? "mobile" : "web",
        deviceCapabilities: { touch: matchMedia("(pointer: coarse)").matches, hover: matchMedia("(hover: hover)").matches },
        styles: { variables: currentStyles() },
        bivy: { data, state: stateRef.current },
      }),
      sendMessage: (text) => {
        // The person has to have used the widget: focus is in its frame only
        // after a click or a key press there. A widget cannot speak for them
        // just by loading.
        if (document.activeElement !== frame.current) throw new WidgetRefusal("Message sending denied: use the widget to send.");
        if (!sessionId || controller.store.getState().activeSession.activeSessionId !== sessionId) throw new WidgetRefusal("Message sending denied: open this session to reply.");
        const now = Date.now();
        if (now - lastMessage.current < MESSAGE_INTERVAL_MS) throw new WidgetRefusal("Message sending denied: one at a time.");
        lastMessage.current = now;
        controller.sendPrompt(text);
      },
      openLink: (url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
      setDisplayMode: (next) => {
        setMode(next);
        return next;
      },
      setHeight: (next) => setHeight(Math.max(40, next)),
      saveState: async (state) => {
        stateRef.current = state;
        if (!sessionId) throw new WidgetRefusal("This widget is not in a session.");
        try {
          await controller.widgetCommand("widgets.state.set", sessionId, { key, state });
          void loadStates(sessionId).then((states) => {
            states[key] = { state };
          });
        } catch (error) {
          setNotice("Could not save this widget's changes.");
          throw new WidgetRefusal(error instanceof Error ? error.message : "Could not save.");
        }
      },
      callTool: async (name, args) => {
        if (!sessionId) throw new WidgetRefusal("This widget is not in a session.");
        const reply = await controller.widgetCommand("widgets.tool", sessionId, { name, arguments: args });
        return (reply as { result?: unknown }).result ?? {};
      },
    });
    // The host is rebuilt only when what the widget IS changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, key]);

  useEffect(() => {
    if (!host) return;
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      void host.receive(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      host.teardown();
    };
  }, [host]);

  // Theme and token changes reach a running widget without reloading it.
  useEffect(() => {
    if (!host) return;
    const update = () => host.contextChanged({ theme: resolvedTheme(), styles: { variables: currentStyles() } });
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, [host]);

  useEffect(() => {
    host?.contextChanged({ displayMode: mode, containerDimensions: { maxHeight: mode === "inline" ? MAX_INLINE_HEIGHT : undefined } });
    if (mode !== "fullscreen") return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setMode("inline");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [host, mode]);

  const collapse = useCallback(() => setMode("inline"), []);

  if (source.state === "error") {
    return (
      <div className="card" data-tone="muted">
        <div className="card-title">{title}</div>
        <div className="card-sub">{source.reason}</div>
      </div>
    );
  }
  return (
    <figure className="widget-component" data-mode={mode}>
      {mode === "fullscreen" && (
        <div className="widget-toolbar">
          <span className="widget-title">{title}</span>
          <button type="button" className="btn ghost" onClick={collapse}>Done</button>
        </div>
      )}
      {host ? (
        <iframe
          ref={frame}
          className="widget-frame"
          src={frameUrl()}
          title={title}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          style={mode === "inline" ? { height: `${Math.min(height, MAX_INLINE_HEIGHT)}px` } : undefined}
        />
      ) : (
        <div className="widget-frame widget-placeholder" style={{ height: `${declaredHeight}px` }} aria-busy="true" aria-label={`${title} is loading`} />
      )}
      {(caption || notice) && mode === "inline" && (
        <figcaption className="card-sub">
          {caption}
          {notice && `${caption ? " · " : ""}${notice}`}
        </figcaption>
      )}
    </figure>
  );
}
