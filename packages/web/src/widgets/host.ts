// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
//
// The host side of a chat widget: what the app answers when a widget, framed in
// /widget-frame.html, talks to it.
//
// The wire protocol is MCP Apps (JSON-RPC 2.0 over postMessage, spec
// 2026-01-26), so a view written for any MCP Apps host runs here unchanged and a
// Bivy widget runs there. Bivy adds one method, `bivy/state/set`, and a `bivy`
// field in the host context; both are ignored by anything that does not know
// them.
//
// Every method is a ROW in the table below. This file holds no DOM: the
// component (components/Widget.tsx) supplies the effects as `WidgetHostDeps`,
// which is also what keeps the protocol testable on its own.

export const WIDGET_PROTOCOL_VERSION = "2026-01-26";

export type DisplayMode = "inline" | "fullscreen";

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A refusal the widget can read. -32000 is the code MCP Apps uses for "the
 *  host said no"; -32601 for a method this host does not have. */
export class WidgetRefusal extends Error {
  constructor(message: string, readonly code = -32000) {
    super(message);
  }
}

export interface WidgetHostDeps {
  /** Post to the frame. Its origin is opaque, so this is always `"*"`. */
  post(message: JsonRpcMessage): void;
  /** The widget's document, sent once the frame is ready for it. */
  html: string;
  /** The context sent in ui/initialize and merged on later changes. */
  context(): Record<string, unknown>;
  /** The input the agent placed the widget with. */
  data: Record<string, unknown>;
  /** Send `text` to the agent as the user, or throw a WidgetRefusal. */
  sendMessage(text: string): void;
  openLink(url: string): void;
  setDisplayMode(mode: DisplayMode): DisplayMode;
  setHeight(height: number): void;
  saveState(state: unknown): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

type Handler = (params: Record<string, unknown>, deps: WidgetHostDeps) => unknown | Promise<unknown>;

function textOf(params: Record<string, unknown>): string {
  // `content` is a single block in the spec's examples and an array in the
  // SDK's; accept both, and plain `text` for hand-written widgets.
  const content = params.content;
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  const text = blocks
    .map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
    .join("\n")
    .trim();
  return text || (typeof params.text === "string" ? params.text.trim() : "");
}

/** Requests a widget may make: method → what it does. */
const REQUESTS: Record<string, Handler> = {
  "ui/initialize": (_params, deps) => ({
    protocolVersion: WIDGET_PROTOCOL_VERSION,
    hostInfo: { name: "Bivy", version: "1" },
    hostCapabilities: {
      openLinks: {},
      logging: {},
      serverTools: {},
      experimental: { bivy: { state: true } },
    },
    hostContext: deps.context(),
  }),
  "ui/message": (params, deps) => {
    const text = textOf(params);
    if (!text) throw new WidgetRefusal("Invalid message format");
    deps.sendMessage(text);
    return {};
  },
  "ui/open-link": (params, deps) => {
    let url: URL;
    try {
      url = new URL(String(params.url ?? ""));
    } catch {
      throw new WidgetRefusal("Invalid URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new WidgetRefusal("Invalid URL");
    deps.openLink(url.href);
    return {};
  },
  "ui/request-display-mode": (params, deps) => ({ mode: deps.setDisplayMode(params.mode === "fullscreen" ? "fullscreen" : "inline") }),
  // What the widget wants the agent to know is kept with its state, where
  // `bivy widget state` shows it to the agent.
  "ui/update-model-context": async (params, deps) => {
    await deps.saveState({ ...(currentState(deps) ?? {}), modelContext: params.structuredContent ?? params.content ?? null });
    return {};
  },
  "bivy/state/set": async (params, deps) => {
    await deps.saveState(params.state ?? null);
    return {};
  },
  "tools/call": async (params, deps) => {
    const name = typeof params.name === "string" ? params.name : "";
    if (!name) throw new WidgetRefusal("Tool name is required", -32602);
    const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
    return deps.callTool(name, args);
  },
  ping: () => ({}),
};

function currentState(deps: WidgetHostDeps): Record<string, unknown> | null {
  const bivy = deps.context().bivy as { state?: unknown } | undefined;
  return bivy?.state && typeof bivy.state === "object" ? (bivy.state as Record<string, unknown>) : null;
}

/** The tallest a widget may make itself inline; fullscreen has no limit. */
export const MAX_INLINE_HEIGHT = 720;

export class WidgetHost {
  private initialized = false;

  constructor(private readonly deps: WidgetHostDeps) {}

  /** Handle one message the frame posted. Returns nothing; answers are posted. */
  async receive(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") return;
    const msg = message as JsonRpcMessage;
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return;
    const params = msg.params && typeof msg.params === "object" ? msg.params : {};

    if (msg.id === undefined) {
      this.notification(msg.method, params);
      return;
    }
    const handler = REQUESTS[msg.method];
    if (!handler) {
      this.deps.post({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Bivy does not support ${msg.method}` } });
      return;
    }
    try {
      const result = await handler(params, this.deps);
      this.deps.post({ jsonrpc: "2.0", id: msg.id, result: result ?? {} });
    } catch (error) {
      const code = error instanceof WidgetRefusal ? error.code : -32000;
      const text = error instanceof Error ? error.message : "Refused";
      this.deps.post({ jsonrpc: "2.0", id: msg.id, error: { code, message: text } });
    }
  }

  private notification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "ui/notifications/sandbox-proxy-ready":
        this.deps.post({ jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: { html: this.deps.html } });
        return;
      case "ui/notifications/initialized":
        // The spec's order: input, then result. Sent once — a widget whose
        // runtime and SDK both initialize must not see its input twice.
        if (this.initialized) return;
        this.initialized = true;
        this.deps.post({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: this.deps.data } });
        this.deps.post({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: { content: [{ type: "text", text: JSON.stringify(this.deps.data) }], structuredContent: this.deps.data },
        });
        return;
      case "ui/notifications/size-changed": {
        const height = Number(params.height);
        if (Number.isFinite(height) && height > 0) this.deps.setHeight(Math.ceil(height));
        return;
      }
      default:
        // notifications/message (logging) and anything newer: nothing to do.
        return;
    }
  }

  /** Tell the widget something about its surroundings changed (theme, mode). */
  contextChanged(patch: Record<string, unknown>): void {
    if (!this.initialized) return;
    this.deps.post({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: patch });
  }

  /** Ask the widget to wind down before it is removed. Fire and forget. */
  teardown(): void {
    if (!this.initialized) return;
    this.deps.post({ jsonrpc: "2.0", id: "bivy-teardown", method: "ui/resource-teardown", params: { reason: "removed" } });
  }
}

// ---------------------------------------------------------------------------
// Theme
//
// The app's design tokens go to the widget twice: under their own names (so a
// widget can use `var(--accent)` like the app does) and under the MCP Apps
// standard names (so a view written for another host picks up Bivy's look).
// ---------------------------------------------------------------------------

/** Bivy tokens a widget gets, by name. */
export const WIDGET_TOKENS = [
  "--bg", "--surface", "--surface-2", "--surface-3", "--ink", "--muted", "--line", "--line-strong",
  "--accent", "--accent-hover", "--accent-soft", "--accent-contrast", "--focus-ring",
  "--ok", "--danger", "--danger-soft", "--unseen", "--merged", "--info", "--warn", "--warn-soft",
  "--font-sans", "--font-mono", "--font-serif",
  "--text-xs", "--text-sm", "--text-base", "--text-md", "--text-lg", "--text-xl", "--text-2xl",
  "--lh-sm", "--lh-base", "--lh-md",
  "--weight-normal", "--weight-medium", "--weight-semibold", "--weight-bold",
  "--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--space-6",
  "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-full",
  "--shadow-sm", "--shadow-md", "--shadow-lg",
] as const;

/** MCP Apps standard variable → the Bivy token that answers it. */
export const STANDARD_VARIABLES: Record<string, string> = {
  "--color-background-primary": "--surface",
  "--color-background-secondary": "--surface-2",
  "--color-background-tertiary": "--surface-3",
  "--color-background-inverse": "--ink",
  "--color-background-info": "--accent-soft",
  "--color-background-danger": "--danger-soft",
  "--color-background-warning": "--warn-soft",
  "--color-text-primary": "--ink",
  "--color-text-secondary": "--muted",
  "--color-text-inverse": "--surface",
  "--color-text-info": "--accent",
  "--color-text-danger": "--danger",
  "--color-text-success": "--ok",
  "--color-text-warning": "--unseen",
  "--color-border-primary": "--line",
  "--color-border-secondary": "--line-strong",
  "--color-border-danger": "--danger",
  "--color-border-info": "--accent",
  "--color-ring-primary": "--focus-ring",
  "--font-sans": "--font-sans",
  "--font-mono": "--font-mono",
  "--font-weight-normal": "--weight-normal",
  "--font-weight-medium": "--weight-medium",
  "--font-weight-semibold": "--weight-semibold",
  "--font-weight-bold": "--weight-bold",
  "--font-text-xs-size": "--text-xs",
  "--font-text-sm-size": "--text-sm",
  "--font-text-md-size": "--text-md",
  "--font-text-lg-size": "--text-lg",
  "--font-heading-sm-size": "--text-md",
  "--font-heading-md-size": "--text-lg",
  "--font-heading-lg-size": "--text-xl",
  "--font-heading-xl-size": "--text-2xl",
  "--border-radius-sm": "--radius-sm",
  "--border-radius-md": "--radius-md",
  "--border-radius-lg": "--radius-lg",
  "--border-radius-xl": "--radius-xl",
  "--border-radius-full": "--radius-full",
  "--shadow-sm": "--shadow-sm",
  "--shadow-md": "--shadow-md",
  "--shadow-lg": "--shadow-lg",
};

/** The token values in effect right now, read off the app's own root. */
export function widgetStyleVariables(read: (name: string) => string): Record<string, string> {
  const own: Record<string, string> = {};
  for (const name of WIDGET_TOKENS) {
    const value = read(name).trim();
    if (value) own[name] = value;
  }
  const standard: Record<string, string> = {};
  for (const [name, token] of Object.entries(STANDARD_VARIABLES)) if (own[token]) standard[name] = own[token];
  return { ...standard, ...own };
}
