// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// DirectTransport — the local / same-origin path used by the installed PWA when
// it points straight at a node (`?local=1`, manifest start_url). Faithful port
// of connectDirect()/sendDirect()/directApi()/directBootstrap() from
// public/app/remote-app.js.
//
// The command->REST mapping is deliberately identical to the legacy switch so
// behaviour is unchanged, except commands that must exercise the raw event WS
// (ping/terminal). Only the shape (a class with injected fetch/WebSocket) is new,
// which is what makes it unit-testable and reusable by Expo later.

import type { Command, ServerEvent, Transport, TransportHandlers, ConnectionStatus } from "./protocol.js";

export interface DirectTransportOptions {
  /** Base origin for API calls; defaults to same-origin (""). */
  origin?: string;
  /** Session-scoped token store. Defaults to window.sessionStorage when present. */
  tokenStore?: Pick<Storage, "getItem" | "setItem">;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to global WebSocket. */
  webSocketImpl?: typeof WebSocket;
  /** Optional bootstrap token from the launch URL (?bootstrap=...). */
  bootstrap?: string;
  handlers: TransportHandlers;
}

const TOKEN_KEY = "bivy_local_token";
const MAX_BACKOFF = 15000;

export class DirectTransport implements Transport {
  private readonly origin: string;
  private readonly tokenStore?: Pick<Storage, "getItem" | "setItem">;
  private readonly fetchImpl: typeof fetch;
  private readonly WS: typeof WebSocket;
  private readonly bootstrap: string;
  private readonly handlers: TransportHandlers;

  private ws: WebSocket | null = null;
  private connected = false;
  private backoff = 1000;
  private closedByUs = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: DirectTransportOptions) {
    this.origin = opts.origin ?? "";
    this.tokenStore =
      opts.tokenStore ?? (typeof globalThis !== "undefined" ? (globalThis as any).sessionStorage : undefined);
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch?.bind(globalThis) as typeof fetch);
    this.WS = opts.webSocketImpl ?? (globalThis as any).WebSocket;
    this.bootstrap = opts.bootstrap ?? "";
    this.handlers = opts.handlers;
  }

  private token(): string {
    return this.tokenStore?.getItem(TOKEN_KEY) || "";
  }

  private directHeaders(extra?: Record<string, string>): Record<string, string> {
    const token = this.token();
    return {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(extra || {}),
    };
  }

  private async directApi<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.origin}${path}`, {
      ...opts,
      headers: { ...this.directHeaders(), ...((opts.headers as Record<string, string>) || {}) },
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data?.error || `Local request failed (${res.status})`);
      // Preserve any extra fields the node's error payload carried (e.g.
      // session.import's `needsDisclosure`/`disclosure`) so a caller that needs
      // more than the message can read them off the thrown Error, the same way
      // it would off a `*.error` relay-mode event.
      if (data && typeof data === "object") Object.assign(error, data);
      throw error;
    }
    return data as T;
  }

  private async bootstrapAuth(): Promise<void> {
    if (this.token()) return;
    try {
      const data = await this.directApi<{ token?: string }>("/api/auth/bootstrap", {
        method: "POST",
        body: JSON.stringify({ name: "Local Remote UI", bootstrap: this.bootstrap }),
      });
      if (data?.token) this.tokenStore?.setItem(TOKEN_KEY, data.token);
    } catch (e) {
      // Loopback auth is often allowed in dev; continue and let later API calls
      // surface a clearer error if this install requires bootstrap.
      // eslint-disable-next-line no-console
      console.warn("local bootstrap failed", e);
    }
  }

  private setStatus(s: ConnectionStatus): void {
    this.handlers.onStatus(s);
  }

  private emit(event: ServerEvent): void {
    this.handlers.onEvent(event);
  }

  /**
   * Re-emit a REST result as a synthetic event. Spread first, then `type`, so a
   * `type` field in the payload never shadows the intended discriminant (and TS
   * sees a single, well-typed `type`).
   */
  private emitMerged(type: string, payload: unknown, extra?: Record<string, unknown>): void {
    this.emit({ ...(extra || {}), ...((payload as Record<string, unknown>) || {}), type });
  }

  async connect(): Promise<void> {
    this.closedByUs = false;
    this.setStatus("connecting");
    await this.bootstrapAuth();
    const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
    const host = typeof location !== "undefined" ? location.host : this.origin.replace(/^https?:\/\//, "");
    const token = this.token();
    const url = `${proto}//${host}/ws${token ? `?access_token=${encodeURIComponent(token)}` : ""}`;
    const ws = new this.WS(url);
    this.ws = ws;
    const isCurrent = () => ws === this.ws;
    ws.onopen = () => {
      if (!isCurrent()) return;
      this.connected = true;
      this.backoff = 1000;
      this.setStatus("online");
      // Initial sync — mirrors connectDirect()'s onopen burst.
      void this.send({ kind: "sessions.list" });
      void this.send({ kind: "models.list" });
      void this.send({ kind: "runtimes.list" });
      void this.send({ kind: "terminal.list" });
      void this.send({ kind: "terminal.multiplexers" });
    };
    ws.onmessage = (m: MessageEvent) => {
      if (!isCurrent()) return;
      try {
        this.emit(JSON.parse(String(m.data)) as ServerEvent);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      if (!isCurrent() || this.closedByUs) return;
      this.connected = false;
      this.setStatus("reconnecting");
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.closedByUs) void this.connect();
      }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
    };
    ws.onerror = () => {};
  }

  close(): void {
    this.closedByUs = true;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
    }
    this.ws = null;
    this.setStatus("offline");
  }

  /**
   * Force a fresh dial without going through "offline". A socket iOS resumed
   * after suspension can look open (readyState 1, no `onclose`) yet be dead, so
   * we can't wait for the OS to notice — drop it and reconnect. Nulling `ws`
   * first makes the stale socket's onclose a no-op (isCurrent() === false), so
   * it can't schedule a competing reconnect. connect() sets "connecting" itself,
   * so the UI never flashes the "Not connected" state a plain close() would.
   */
  reconnect(): void {
    const stale = this.ws;
    this.ws = null;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      stale?.close();
    } catch {
      /* noop */
    }
    void this.connect();
  }

  /**
   * Command dispatch. Kept byte-for-byte in intent with sendDirect(): each kind
   * maps to a REST call whose result is re-emitted as a synthetic event, so the
   * reducer sees one uniform event stream regardless of transport.
   */
  async send(obj: Command): Promise<void> {
    try {
      switch (obj.kind) {
        case "ping":
          // Liveness must exercise the raw event socket. A REST call can succeed
          // while iOS has resumed a zombie WS that never receives broadcasts.
          if (this.connected && this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
          break;
        case "history": {
          const params = new URLSearchParams({
            ...(obj.sessionId ? { sessionId: String(obj.sessionId) } : {}),
            ...(obj.have != null ? { have: String(obj.have) } : {}),
            ...(obj.haveToken ? { haveToken: String(obj.haveToken) } : {}),
          });
          this.emit(await this.directApi(`/api/session/history?${params}`));
          break;
        }
        case "sessions.list":
          this.emit({ type: "sessions.list", sessions: await this.directApi("/api/sessions") });
          break;
        case "session.open": {
          const p: any = await this.directApi("/api/sessions/open", {
            method: "POST",
            body: JSON.stringify({ path: obj.path, agent: obj.agent, runtimeId: obj.runtimeId }),
          });
          this.emit({
            type: "session.history",
            sessionId: p.id,
            sessionFile: p.sessionFile,
            workspace: p.workspace,
            source: p.source,
            runtimeId: p.runtimeId,
            agentName: p.agentName,
            name: p.name,
            messages: p.messages || [],
            branch: p.branch,
            prUrl: p.prUrl,
          });
          break;
        }
        case "session.new": {
          const p: any = await this.directApi("/api/session", { method: "POST", body: JSON.stringify(obj) });
          this.emit({
            type: "session.history",
            requestId: obj.requestId,
            sessionId: p.id,
            sessionFile: p.sessionFile,
            workspace: p.workspace,
            source: p.source,
            runtimeId: p.runtimeId,
            agentName: p.agentName,
            name: p.name,
            messages: [],
            branch: p.branch,
            prUrl: p.prUrl,
          });
          break;
        }
        case "session.discover": {
          const requestId = String(obj.requestId ?? "");
          try {
            const data: any = await this.directApi("/api/sessions/discover");
            this.emit({ type: "session.discover.result", requestId, sessions: data?.sessions ?? [] });
          } catch (error) {
            this.emit({ type: "session.discover.error", requestId, error: (error as Error)?.message || String(error) });
          }
          break;
        }
        case "attachment.fetch": {
          // Fetch attachment bytes from the local HTTP endpoint and re-emit as an
          // `attachment.data` event, so the client's fetchAttachment() settles the
          // same way it does over the relay (which replies with base64 too).
          const requestId = String(obj.requestId ?? "");
          const hash = String((obj as { hash?: unknown }).hash ?? "");
          try {
            const res = await this.fetchImpl(`${this.origin}/api/attachment/${encodeURIComponent(hash)}`, { headers: this.directHeaders() });
            if (!res.ok) throw new Error(`Attachment fetch failed (${res.status})`);
            const mimeType = res.headers.get("content-type") || "application/octet-stream";
            const buf = new Uint8Array(await res.arrayBuffer());
            // Chunked to keep String.fromCharCode(...) off a huge spread (stack) and
            // to base64 without pulling in a dependency.
            let binary = "";
            const CHUNK = 0x8000;
            for (let i = 0; i < buf.length; i += CHUNK) binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
            this.emit({ type: "attachment.data", requestId, hash, mimeType, data: btoa(binary) });
          } catch (error) {
            this.emit({ type: "attachment.error", requestId, hash, error: (error as Error)?.message || String(error) });
          }
          break;
        }
        case "session.import": {
          const requestId = String(obj.requestId ?? "");
          try {
            const p: any = await this.directApi("/api/sessions/import", {
              method: "POST",
              body: JSON.stringify({ runtimeId: obj.runtimeId, ref: obj.ref, acceptDisclosure: obj.acceptDisclosure }),
            });
            this.emit({ type: "session.import.result", requestId, sessionId: p.sessionId, runtimeId: p.runtimeId, mode: p.mode, seedPrompt: p.seedPrompt });
          } catch (error) {
            // A "needs disclosure" refusal (see importNativeSession) rides the
            // thrown Error's extra fields (attached by directApi above) rather
            // than a generic message, so the caller can show the disclosure and
            // retry with acceptDisclosure instead of treating this as a hard failure.
            const e = error as { message?: unknown; needsDisclosure?: unknown; disclosure?: unknown };
            this.emit({ type: "session.import.error", requestId, error: String(e?.message ?? error), needsDisclosure: e?.needsDisclosure, disclosure: e?.disclosure });
          }
          break;
        }
        case "session.delete":
          await this.directApi("/api/sessions/delete", {
            method: "POST",
            body: JSON.stringify({ id: obj.sessionId, path: obj.path }),
          });
          break;
        case "session.rename":
          await this.directApi("/api/sessions/rename", {
            method: "POST",
            body: JSON.stringify({ sessionId: obj.sessionId, name: obj.name }),
          });
          break;
        case "session.pr.refresh":
          this.emitMerged(
            "session.pr_result",
            await this.directApi("/api/session/pr/refresh", { method: "POST", body: JSON.stringify({ sessionId: obj.sessionId }) }),
            { sessionId: String(obj.sessionId ?? "") },
          );
          break;
        case "sessions.pr.refresh_all":
          this.emitMerged("sessions.pr_refresh_result", await this.directApi("/api/sessions/pr/refresh", { method: "POST" }));
          break;
        case "prompt":
          await this.directApi("/api/session/prompt", { method: "POST", body: JSON.stringify(obj) });
          break;
        case "abort":
          await this.directApi("/api/session/abort", { method: "POST", body: JSON.stringify({ sessionId: obj.sessionId }) });
          break;
        case "session.command.invoke":
          // Protocol-mode agent command. Any output rides back over the live WS
          // (session.status / message / session.done), so no synthetic event here.
          await this.directApi("/api/session/command", {
            method: "POST",
            body: JSON.stringify({ sessionId: obj.sessionId, name: obj.name, args: obj.args }),
          });
          break;
        case "session.pause":
          await this.directApi("/api/session/pause", { method: "POST", body: JSON.stringify({ sessionId: obj.sessionId }) });
          this.emit({ type: "session.paused", sessionId: String(obj.sessionId ?? "") });
          break;
        case "session.resume":
          await this.directApi("/api/session/resume", { method: "POST", body: JSON.stringify({ sessionId: obj.sessionId }) });
          this.emit({ type: "session.resumed", sessionId: String(obj.sessionId ?? "") });
          break;
        case "session.checkpoints": {
          const result = await this.directApi("/api/session/checkpoints", {
            method: "POST",
            body: JSON.stringify({ sessionId: obj.sessionId }),
          });
          this.emit({ type: "session.checkpoints", sessionId: String(obj.sessionId ?? ""), checkpoints: (result as { checkpoints?: unknown })?.checkpoints ?? [] });
          break;
        }
        case "session.rewind":
          await this.directApi("/api/session/rewind", {
            method: "POST",
            body: JSON.stringify({ sessionId: obj.sessionId, checkpointId: obj.checkpointId }),
          });
          // The node also broadcasts session.rewound over the live WS; the
          // synthetic emit gives the acting client immediate feedback.
          this.emit({ type: "session.rewound", sessionId: String(obj.sessionId ?? ""), checkpointId: String(obj.checkpointId ?? "") });
          break;
        case "session.question.answer":
          // No synthetic event here, same as "approval" below: the node
          // confirms via its own session.question.resolved broadcast (which
          // reaches this client over the live WS regardless of transport mode),
          // and the card stays up showing a pending state until then.
          await this.directApi("/api/session/question/answer", {
            method: "POST",
            body: JSON.stringify({ sessionId: obj.sessionId, requestId: obj.requestId, answers: obj.answers, cancelled: obj.cancelled }),
          });
          break;
        case "models.list":
          this.emitMerged(
            "models.list",
            await this.directApi(`/api/models?${new URLSearchParams(obj.sessionId ? { sessionId: String(obj.sessionId) } : {})}`),
          );
          break;
        case "model.select":
          await this.directApi("/api/models/select", { method: "POST", body: JSON.stringify(obj) });
          break;
        case "thinking.set_level":
          await this.directApi("/api/thinking/set-level", { method: "POST", body: JSON.stringify(obj) });
          break;
        case "node.stats": {
          const q = new URLSearchParams(obj.sessionId ? { sessionId: String(obj.sessionId) } : {});
          this.emit({ type: "node.stats", stats: await this.directApi(`/api/node/stats?${q}`) });
          break;
        }
        case "runtimes.list":
          this.emitMerged("runtimes.list", await this.directApi("/api/runtimes"));
          break;
        case "runtime.select":
          this.emitMerged(
            "runtime.updated",
            await this.directApi("/api/runtimes/select", { method: "POST", body: JSON.stringify({ id: obj.id }) }),
          );
          break;
        case "runtime.install":
          this.emitMerged(
            "runtime.install.done",
            await this.directApi("/api/runtimes/install", { method: "POST", body: JSON.stringify({ id: obj.id }) }),
            { id: String(obj.id ?? "") },
          );
          break;
        case "providers.list":
          this.emitMerged("providers.list", await this.directApi("/api/auth/providers"));
          break;
        case "provider.auth.get":
          this.emitMerged(
            "provider.auth",
            await this.directApi(`/api/auth/providers/${encodeURIComponent(String(obj.provider || ""))}`),
          );
          break;
        case "provider.apiKey": {
          const requestId = String(obj.requestId ?? "");
          try {
            this.emitMerged(
              "providers.list",
              await this.directApi("/api/auth/api-key", {
                method: "POST",
                body: JSON.stringify({ provider: obj.provider, key: obj.key }),
              }),
            );
            // Dedicated per-request ack, mirroring the relay path — see #140.
            this.emit({ type: "provider.apiKey.ok", requestId });
          } catch (error) {
            this.emit({ type: "provider.apiKey.error", requestId, error: error instanceof Error ? error.message : String(error) });
          }
          break;
        }
        case "provider.remove":
          this.emitMerged(
            "providers.list",
            await this.directApi(`/api/auth/providers/${encodeURIComponent(String(obj.provider || ""))}`, { method: "DELETE" }),
          );
          break;
        case "models.custom.list":
          this.emitMerged("models.custom.list", await this.directApi("/api/models/custom"));
          break;
        case "models.custom.presets":
          this.emitMerged("models.custom.presets", await this.directApi("/api/models/catalog"));
          break;
        case "models.custom.save": {
          const requestId = String(obj.requestId ?? "");
          try {
            this.emitMerged(
              "models.custom.list",
              await this.directApi("/api/models/custom", {
                method: "POST",
                body: JSON.stringify((obj as any).spec ?? obj),
              }),
            );
            // Dedicated per-request ack, mirroring the relay path — see #140.
            this.emit({ type: "models.custom.save.ok", requestId });
          } catch (error) {
            this.emit({ type: "models.custom.save.error", requestId, error: error instanceof Error ? error.message : String(error) });
          }
          break;
        }
        case "models.custom.remove":
          this.emitMerged(
            "models.custom.list",
            await this.directApi(`/api/models/custom/${encodeURIComponent(String((obj as any).id ?? obj.provider ?? ""))}`, { method: "DELETE" }),
          );
          break;
        case "rulesets.list":
          this.emitMerged("rulesets.list", await this.directApi("/api/rulesets"));
          break;
        case "rulesets.save": {
          const requestId = String(obj.requestId ?? "");
          try {
            this.emitMerged(
              "rulesets.list",
              await this.directApi("/api/rulesets", { method: "POST", body: JSON.stringify(obj) }),
            );
            // Dedicated per-request ack, mirroring the relay path — see #140.
            this.emit({ type: "rulesets.save.ok", requestId });
          } catch (error) {
            this.emit({ type: "rulesets.save.error", requestId, error: error instanceof Error ? error.message : String(error) });
          }
          break;
        }
        case "rulesets.remove":
          this.emitMerged(
            "rulesets.list",
            await this.directApi(`/api/rulesets/${encodeURIComponent(String((obj as any).name ?? ""))}`, { method: "DELETE" }),
          );
          break;
        case "repos.list":
          this.emitMerged("repos.list", await this.directApi("/api/repos"));
          break;
        case "branches.list":
          this.emitMerged(
            "branches.list",
            await this.directApi(`/api/repos/branches?repo=${encodeURIComponent(String(obj.repo || ""))}`),
          );
          break;
        case "workspaces.list":
          this.emitMerged("workspaces.list", await this.directApi("/api/workspaces"));
          break;
        case "node.settings.get":
          this.emit({
            type: "node.settings",
            requestId: String(obj.requestId ?? ""),
            settings: await this.directApi("/api/node/settings"),
          });
          break;
        case "node.settings.set": {
          const requestId = String(obj.requestId ?? "");
          try {
            const res = await this.directApi("/api/node/settings", {
              method: "POST",
              body: JSON.stringify((obj.settings as Record<string, unknown>) ?? obj),
            });
            this.emit({ type: "node.settings", requestId, settings: (res as { settings?: unknown })?.settings ?? res });
          } catch (error) {
            this.emit({ type: "node.settings.error", requestId, error: error instanceof Error ? error.message : String(error) });
          }
          break;
        }
        case "provider.oauth.reset":
          this.emitMerged(
            "provider.oauth.reset",
            await this.directApi(`/api/auth/providers/${encodeURIComponent(String(obj.provider || ""))}`, { method: "DELETE" }),
            { provider: String(obj.provider ?? "") },
          );
          break;
        case "provider.oauth.start":
          this.emitMerged(
            "provider.oauth.started",
            await this.directApi("/api/auth/oauth/start", { method: "POST", body: JSON.stringify({ provider: obj.provider }) }),
            { provider: String(obj.provider ?? "") },
          );
          break;
        case "provider.oauth.code":
          await this.directApi(`/api/auth/oauth/${encodeURIComponent(String(obj.id))}/manual-code`, {
            method: "POST",
            body: JSON.stringify({ code: obj.code }),
          });
          break;
        case "github.app.manifest.start":
          try {
            this.emitMerged(
              "github.app.manifest.ready",
              await this.directApi("/api/github/app/manifest/start", {
                method: "POST",
                body: JSON.stringify({ origin: obj.origin, org: obj.org }),
              }),
              { requestId: String(obj.requestId ?? "") },
            );
          } catch (error) {
            this.emit({ type: "github.app.manifest.error", requestId: String(obj.requestId ?? ""), error: error instanceof Error ? error.message : String(error) });
          }
          break;
        case "github.app.manifest.code":
          try {
            this.emitMerged(
              "github.app.manifest.done",
              await this.directApi("/api/github/app/manifest/complete", {
                method: "POST",
                body: JSON.stringify({ code: obj.code, state: obj.state }),
              }),
              { requestId: String(obj.requestId ?? "") },
            );
          } catch (error) {
            this.emit({ type: "github.app.manifest.error", requestId: String(obj.requestId ?? ""), error: error instanceof Error ? error.message : String(error) });
          }
          break;
        case "github.app.connect-existing":
          try {
            this.emitMerged(
              "github.app.manifest.done",
              await this.directApi("/api/github/app/connect-existing", {
                method: "POST",
                body: JSON.stringify({ appId: obj.appId, privateKeyPem: obj.privateKeyPem, nodeLabel: obj.nodeLabel }),
              }),
              { requestId: String(obj.requestId ?? "") },
            );
          } catch (error) {
            this.emit({ type: "github.app.manifest.error", requestId: String(obj.requestId ?? ""), error: error instanceof Error ? error.message : String(error) });
          }
          break;
        case "github.app.disconnect":
          // No appId = wipe every app's key on this node (the account-wide disconnect).
          await this.directApi("/api/github/app/disconnect", { method: "POST", body: JSON.stringify({ appId: obj.appId }) });
          this.emit({ type: "github.app.disconnected", requestId: String(obj.requestId ?? ""), ok: true });
          break;
        case "approval":
          await this.directApi(
            `/api/approvals/${encodeURIComponent(String(obj.id))}/${obj.approved ? "approve" : "reject"}`,
            { method: "POST", body: "{}" },
          );
          break;
        case "stt.config.get":
          this.emitMerged("stt.config", await this.directApi("/api/stt/config"));
          break;
        case "stt.config.set": {
          const requestId = String(obj.requestId ?? "");
          try {
            this.emitMerged(
              "stt.config",
              await this.directApi("/api/stt/config", {
                method: "POST",
                body: JSON.stringify({ provider: obj.provider, setKey: obj.setKey, removeKey: obj.removeKey }),
              }),
            );
            // Dedicated per-request ack, mirroring the relay path — see #140.
            this.emit({ type: "stt.config.set.ok", requestId });
          } catch (error) {
            this.emit({ type: "stt.config.set.error", requestId, error: error instanceof Error ? error.message : String(error) });
          }
          break;
        }
        case "transcribe":
          // Re-emit the REST result as the same `transcription` event the relay
          // path produces, so the controller resolves one uniform result stream.
          this.emitMerged(
            "transcription",
            await this.directApi("/api/transcribe", {
              method: "POST",
              body: JSON.stringify({ audio: obj.audio, mimeType: obj.mimeType, provider: obj.provider, language: obj.language }),
            }),
            { requestId: String(obj.requestId ?? "") },
          );
          break;
        case "node.update": {
          try {
            await this.directApi("/api/node/update", { method: "POST", body: "{}" });
            this.emit({ type: "node.update.result", ok: true });
          } catch (e) {
            this.emit({ type: "node.update.result", ok: false, error: (e as Error)?.message || String(e) });
          }
          break;
        }
        default:
          // Terminal I/O rides the raw WS in direct mode.
          if (String(obj.kind || "").startsWith("terminal.") && this.connected && this.ws?.readyState === 1) {
            this.ws.send(JSON.stringify(obj));
          }
      }
    } catch (e) {
      this.handlers.onError?.((e as Error)?.message || String(e));
    }
  }
}
