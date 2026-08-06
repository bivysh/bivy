// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import { randomUUID } from "node:crypto";
import type { AttachToChatFn, ToolProvider, ToolResult, ToolSpec } from "../runtime/types.js";
import { IntegrationStore } from "./store.js";
import { ATTACH_TO_CHAT_TOOL, BUILT_IN_INTEGRATIONS } from "./registry.js";
import {
  buildAuthorizeUrl,
  createPkce,
  exchangeCode,
  refreshToken,
  type OAuthClient,
  type TokenSet,
} from "./oauth.js";
import { SecretVault } from "../secrets.js";
import type {
  IntegrationConnection,
  IntegrationDef,
  IntegrationHttp,
  IntegrationPublic,
} from "./types.js";

type OAuth2Spec = Extract<IntegrationDef["auth"], { kind: "oauth2" }>;

type PendingOAuth = {
  id: string;
  integrationId: string;
  redirectUri: string;
  verifier?: string;
  createdAt: number;
};

/**
 * A settable box for a session id that isn't known yet when toolProvider() is
 * called — the runtime/tool set is built before the specific session it will
 * serve exists (see AttachToChatFn's doc in runtime/types.ts). The caller fills
 * `current` in as soon as it knows it (immediately, if resuming an existing
 * record; shortly after, once a fresh session's own id comes back).
 */
export interface SessionIdRef {
  current?: string;
}

/**
 * Owns integration connections and exposes them to any agent as tools.
 *
 * - REST handlers in server.ts call `list / connectApiKey / startOAuth /
 *   completeOAuth / disconnect`.
 * - `toolProvider()` exposes the connected integrations' tools — plus the
 *   always-on `attach_to_chat` tool (issue #291), when the daemon wired an
 *   `attachToChat` callback — as a runtime-agnostic ToolProvider handed to each
 *   session; the tools execute here on the daemon (where credentials live) for
 *   in-process AND remote agents alike.
 */
export class IntegrationManager {
  private readonly store: IntegrationStore;
  private readonly registry: IntegrationDef[];
  private readonly secrets: SecretVault;
  private readonly pending = new Map<string, PendingOAuth>();
  /** Names of tools flagged risky (approval-gated), regardless of connection. */
  private readonly riskyTools: Set<string>;
  /** Backs the native `attach_to_chat` tool (see toolProvider); undefined = the
   *  tool isn't offered (e.g. a test harness that never wired one). */
  private readonly attachToChat?: AttachToChatFn;

  constructor(appDir: string, registry: IntegrationDef[] = BUILT_IN_INTEGRATIONS, attachToChat?: AttachToChatFn) {
    this.store = new IntegrationStore(appDir);
    this.secrets = new SecretVault(appDir);
    this.registry = registry;
    this.riskyTools = new Set(registry.flatMap((d) => d.tools.filter((t) => t.risky).map((t) => t.name)));
    this.attachToChat = attachToChat;
  }

  // --- helpers ------------------------------------------------------------

  private def(id: string): IntegrationDef | undefined {
    return this.registry.find((d) => d.id === id);
  }

  private oauthClient(spec: OAuth2Spec): OAuthClient | undefined {
    const clientId = process.env[spec.clientIdEnv];
    const clientSecret = process.env[spec.clientSecretEnv];
    if (!clientId) return undefined;
    return { clientId, clientSecret: clientSecret ?? "" };
  }

  /** Whether the operator has supplied the credentials needed to connect this integration. */
  private isConfigured(def: IntegrationDef): boolean {
    if (def.auth.kind === "oauth2") return Boolean(this.oauthClient(def.auth));
    return true; // apiKey / none are always "configurable" by the user
  }

  isRiskyTool(toolName: string): boolean {
    return this.riskyTools.has(toolName);
  }

  // --- public views -------------------------------------------------------

  list(): IntegrationPublic[] {
    return this.registry.map((def) => {
      const conn = this.store.get(def.id);
      const status: IntegrationPublic["status"] = conn ? conn.status : "disconnected";
      return {
        id: def.id,
        name: def.name,
        description: def.description,
        icon: def.icon,
        docsUrl: def.docsUrl,
        authKind: def.auth.kind,
        apiKeyLabel: def.auth.kind === "apiKey" ? def.auth.label : undefined,
        apiKeyHelp: def.auth.kind === "apiKey" ? def.auth.help : undefined,
        configured: this.isConfigured(def),
        status,
        accountLabel: conn?.accountLabel,
        toolNames: def.tools.map((t) => t.name),
      };
    });
  }

  // --- connect / disconnect ----------------------------------------------

  async connectApiKey(id: string, key: string): Promise<IntegrationConnection> {
    const def = this.def(id);
    if (!def) throw new Error(`Unknown integration: ${id}`);
    if (def.auth.kind !== "apiKey") throw new Error(`${id} does not use an API key`);
    if (!key.trim()) throw new Error("API key is required");
    const secretId = `integration.${id}.api-key`;
    this.secrets.setLocal(secretId, key.trim(), `${def.name} API key`);
    const conn: IntegrationConnection = { id, status: "connected", apiKeyRef: `secret://${secretId}`, connectedAt: Date.now() };
    this.store.set(conn);
    return conn;
  }

  /** Begin an OAuth2 flow; returns the URL the user should open. */
  startOAuth(id: string, redirectUri: string): { authUrl: string; state: string } {
    const def = this.def(id);
    if (!def || def.auth.kind !== "oauth2") throw new Error(`${id} is not an OAuth integration`);
    const client = this.oauthClient(def.auth);
    if (!client) {
      throw new Error(`Set ${def.auth.clientIdEnv} (and ${def.auth.clientSecretEnv}) to connect ${def.name}`);
    }
    const state = randomUUID();
    const pkce = def.auth.pkce ? createPkce() : undefined;
    this.pending.set(state, { id: state, integrationId: id, redirectUri, verifier: pkce?.verifier, createdAt: Date.now() });
    const authUrl = buildAuthorizeUrl(def.auth, {
      clientId: client.clientId,
      redirectUri,
      state,
      codeChallenge: pkce?.challenge,
    });
    return { authUrl, state };
  }

  /** Complete an OAuth2 flow from the redirect callback. */
  async completeOAuth(state: string, code: string): Promise<IntegrationConnection> {
    const pending = this.pending.get(state);
    if (!pending) throw new Error("Unknown or expired OAuth state");
    this.pending.delete(state);
    const def = this.def(pending.integrationId);
    if (!def || def.auth.kind !== "oauth2") throw new Error("Integration is no longer available");
    const client = this.oauthClient(def.auth);
    if (!client) throw new Error("OAuth client credentials are no longer configured");

    const token = await exchangeCode(def.auth, client, {
      code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.verifier,
    });

    const secretId = `integration.${def.id}.oauth`;
    this.secrets.setLocal(secretId, JSON.stringify(token), `${def.name} OAuth token set`);
    const conn: IntegrationConnection = {
      id: def.id,
      status: "connected",
      oauthRef: `secret://${secretId}`,
      connectedAt: Date.now(),
    };
    this.store.set(conn);

    // Best-effort: label the connection with the account email/workspace.
    if (def.auth.accountLabel) {
      try {
        const label = await def.auth.accountLabel(this.httpFor(def, conn));
        if (label) {
          conn.accountLabel = label;
          this.store.set(conn);
        }
      } catch {
        // ignore labeling failures
      }
    }
    return conn;
  }

  disconnect(id: string): boolean {
    this.secrets.delete(`integration.${id}.api-key`);
    this.secrets.delete(`integration.${id}.oauth`);
    return this.store.remove(id);
  }

  // --- auth'd HTTP --------------------------------------------------------

  /** Build a fetch helper bound to a connection: auth header + baseUrl + refresh. */
  private httpFor(def: IntegrationDef, conn: IntegrationConnection): IntegrationHttp {
    const resolve = (input: string) =>
      /^https?:\/\//i.test(input) ? input : `${(def.baseUrl ?? "").replace(/\/$/, "")}${input.startsWith("/") ? "" : "/"}${input}`;

    const oauthToken = async (): Promise<TokenSet | undefined> => {
      if (conn.oauthRef) {
        const raw = await this.secrets.resolve(conn.oauthRef);
        return raw ? JSON.parse(raw) as TokenSet : undefined;
      }
      return conn.oauth;
    };

    const authHeaders = async (): Promise<Record<string, string>> => {
      if (def.auth.kind === "apiKey") {
        const key = conn.apiKeyRef ? await this.secrets.resolve(conn.apiKeyRef) : conn.apiKey;
        if (key) return def.auth.header ? def.auth.header(key) : { authorization: `Bearer ${key}` };
      }
      const token = await oauthToken();
      if (token?.accessToken) {
        return { authorization: `${token.tokenType || "Bearer"} ${token.accessToken}` };
      }
      return {};
    };

    const ensureFreshToken = async () => {
      if (def.auth.kind !== "oauth2") return;
      const token = await oauthToken();
      if (!token) return;
      const expiringSoon = token.expiresAt !== undefined && token.expiresAt - Date.now() < 60_000;
      if (!expiringSoon || !token.refreshToken) return;
      const client = this.oauthClient(def.auth);
      if (!client) return;
      await this.applyRefresh(def, conn, client, token.refreshToken);
    };

    const send = async (input: string, init: RequestInit = {}, didRefresh = false): Promise<Response> => {
      await ensureFreshToken();
      const res = await fetch(resolve(input), {
        ...init,
        headers: { ...(await authHeaders()), ...(init.headers as Record<string, string> | undefined) },
      });
      // Reactive refresh: token rejected unexpectedly -> refresh once and retry.
      const token = await oauthToken();
      if (res.status === 401 && !didRefresh && def.auth.kind === "oauth2" && token?.refreshToken) {
        const client = this.oauthClient(def.auth);
        if (client) {
          await this.applyRefresh(def, conn, client, token.refreshToken);
          return send(input, init, true);
        }
      }
      return res;
    };

    const http = ((input: string, init?: RequestInit) => send(input, init ?? {})) as IntegrationHttp;
    http.json = async <T,>(input: string, init?: RequestInit): Promise<T> => {
      const res = await send(input, init ?? {});
      const body = await res.text();
      if (!res.ok) throw new Error(`${def.name} request failed (${res.status}): ${body.slice(0, 300)}`);
      return (body ? JSON.parse(body) : undefined) as T;
    };
    return http;
  }

  private async applyRefresh(def: IntegrationDef, conn: IntegrationConnection, client: OAuthClient, refresh: string) {
    if (def.auth.kind !== "oauth2") return;
    let next: TokenSet;
    try {
      next = await refreshToken(def.auth, client, refresh);
    } catch (error) {
      conn.status = "error";
      conn.error = error instanceof Error ? error.message : String(error);
      this.store.set(conn);
      throw error;
    }
    if (conn.oauthRef?.startsWith("secret://")) this.secrets.setLocal(conn.oauthRef.slice("secret://".length), JSON.stringify(next));
    else conn.oauth = next;
    conn.status = "connected";
    conn.error = undefined;
    this.store.set(conn);
  }

  // --- agent-agnostic tool provider ---------------------------------------

  /**
   * A runtime-agnostic ToolProvider exposing every connected integration's tools,
   * plus the always-on `attach_to_chat` tool (issue #291) when this manager was
   * built with an `attachToChat` callback. This is the seam the daemon hands to a
   * session (in-process OR remote) so any agent can use the tools without the
   * IntegrationManager knowing which agent it is — the tools execute HERE, on the
   * daemon, where the credentials/HTTP clients live. A snapshot of the connected
   * set is taken per call (at session start), mirroring the previous per-session
   * behavior; disconnected integrations contribute nothing, so the tool surface
   * and system prompt stay clean.
   *
   * `sessionIdRef` resolves the calling session for `attach_to_chat`: the
   * provider is built before the session it will serve exists (see
   * AttachToChatFn's doc), so the caller passes a box and fills `.current` in
   * once the id is known rather than a plain string. Ignored (and the tool
   * omitted) when either it or the attachToChat callback is absent.
   */
  toolProvider(sessionIdRef?: SessionIdRef): ToolProvider {
    const specs: ToolSpec[] = [];
    const executors = new Map<string, (params: unknown, signal?: AbortSignal) => Promise<ToolResult>>();
    for (const def of this.registry) {
      const conn = this.store.get(def.id);
      if (!conn || conn.status !== "connected") continue;
      const http = this.httpFor(def, conn);
      for (const tool of def.tools) {
        specs.push({ name: tool.name, label: tool.label, description: tool.description, promptSnippet: tool.description, parameters: tool.parameters });
        executors.set(tool.name, async (params, signal) => {
          try {
            const result = await tool.execute(params as any, http, signal);
            return { details: {}, ...result };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: `${tool.name} failed: ${message}` }], details: {}, isError: true };
          }
        });
      }
    }
    if (this.attachToChat && sessionIdRef) {
      const attachToChat = this.attachToChat;
      specs.push({
        name: ATTACH_TO_CHAT_TOOL.name,
        label: ATTACH_TO_CHAT_TOOL.label,
        description: ATTACH_TO_CHAT_TOOL.description,
        promptSnippet: ATTACH_TO_CHAT_TOOL.description,
        parameters: ATTACH_TO_CHAT_TOOL.parameters,
      });
      executors.set(ATTACH_TO_CHAT_TOOL.name, async (params) => {
        const sessionId = sessionIdRef.current;
        if (!sessionId) return { content: [{ type: "text", text: "Session is not ready yet — try again in a moment." }], details: {}, isError: true };
        const p = (params ?? {}) as { filePath?: unknown; caption?: unknown };
        const filePath = typeof p.filePath === "string" ? p.filePath.trim() : "";
        if (!filePath) return { content: [{ type: "text", text: "filePath is required" }], details: {}, isError: true };
        const caption = typeof p.caption === "string" ? p.caption : undefined;
        const result = attachToChat(sessionId, { filePath, caption });
        if ("error" in result) return { content: [{ type: "text", text: result.error }], details: {}, isError: true };
        return { content: [{ type: "text", text: `Attached ${result.ref.name} (${result.ref.kind}, ${result.ref.mimeType}) to the chat.` }], details: { ref: result.ref } };
      });
    }
    return {
      list: () => specs,
      invoke: async (toolName, _toolCallId, params, signal) => {
        const exec = executors.get(toolName);
        if (!exec) return { content: [{ type: "text", text: `Unknown integration tool: ${toolName}` }], details: {}, isError: true };
        return exec(params, signal);
      },
    };
  }
}
