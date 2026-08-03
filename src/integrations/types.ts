// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import type { TSchema } from "typebox";

// An integration is a declarative bundle: how to authenticate + a few tools the
// LLM can call. The daemon owns credentials/OAuth; the tools just receive an
// already-authenticated `http` helper. Adding a new integration (Notion, Gmail,
// Dropbox, ...) is one of these objects — no changes to the server plumbing.

/** Result shape returned by an integration tool (a runtime-agnostic tool result). */
export interface IntegrationToolResult {
  content: { type: "text"; text: string }[];
  details?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * A fetch wrapper bound to one connected account. It injects the auth header,
 * resolves relative URLs against the integration's `baseUrl`, and transparently
 * refreshes expired OAuth tokens. Tools should use this instead of raw `fetch`.
 */
export interface IntegrationHttp {
  (input: string, init?: RequestInit): Promise<Response>;
  /** Convenience: fetch + throw on non-2xx + parse JSON. */
  json<T = unknown>(input: string, init?: RequestInit): Promise<T>;
}

export interface IntegrationToolDef {
  /** Globally unique, snake_case, e.g. "gmail_search". Becomes the LLM tool name. */
  name: string;
  label: string;
  description: string;
  /** When true, calls are routed through the in-chat approval gate (e.g. send email, upload). */
  risky?: boolean;
  parameters: TSchema;
  execute: (params: any, http: IntegrationHttp, signal?: AbortSignal) => Promise<IntegrationToolResult>;
}

export type IntegrationAuthSpec =
  | { kind: "none" }
  | {
      kind: "apiKey";
      /** Label shown in the connect form, e.g. "Notion internal integration token". */
      label: string;
      help?: string;
      placeholder?: string;
      /** How the stored key is presented on requests. Default: Bearer header. */
      header?: (key: string) => Record<string, string>;
    }
  | {
      kind: "oauth2";
      authUrl: string;
      tokenUrl: string;
      scopes: string[];
      /** Env vars holding the OAuth app credentials the operator registered. */
      clientIdEnv: string;
      clientSecretEnv: string;
      /** Use PKCE (recommended; required by some providers for public clients). */
      pkce?: boolean;
      /** Extra params appended to the authorize URL (e.g. access_type=offline). */
      extraAuthParams?: Record<string, string>;
      /** Optional: fetch a human label for the connected account (email, workspace). */
      accountLabel?: (http: IntegrationHttp) => Promise<string | undefined>;
    };

export interface IntegrationDef {
  id: string;
  name: string;
  description: string;
  icon?: string;
  docsUrl?: string;
  /** Prefix for relative URLs passed to the tool's `http` helper. */
  baseUrl?: string;
  auth: IntegrationAuthSpec;
  tools: IntegrationToolDef[];
}

/**
 * Declarative shape for a built-in tool that (unlike an IntegrationToolDef)
 * needs neither auth nor an `http` client — e.g. `attach_to_chat` (issue #291),
 * which needs the CALLING SESSION's id instead. Kept as data alongside the
 * integrations here for the same reason those are: name/description/schema in
 * one place; IntegrationManager.toolProvider wires the actual execution, where
 * the session-id context this tool needs (but a plain integration tool
 * doesn't) is available.
 */
export interface StandaloneToolDef {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
}

/** Persisted, per-integration connection state. Stored 0600 on disk. */
export interface IntegrationConnection {
  id: string;
  status: "connected" | "error";
  /** For apiKey integrations. Legacy plaintext field; new connections use apiKeyRef. */
  apiKey?: string;
  /** Secret reference for apiKey integrations, e.g. secret://integration.github.api-key. */
  apiKeyRef?: string;
  /** For oauth2 integrations. Legacy plaintext field; new connections use oauthRef. */
  oauth?: {
    accessToken: string;
    refreshToken?: string;
    /** Epoch ms; undefined means "no known expiry". */
    expiresAt?: number;
    scope?: string;
    tokenType?: string;
  };
  /** Secret reference for an encrypted OAuth TokenSet JSON blob. */
  oauthRef?: string;
  accountLabel?: string;
  connectedAt: number;
  error?: string;
}

/** Public, secret-free view of an integration for the UI/API. */
export interface IntegrationPublic {
  id: string;
  name: string;
  description: string;
  icon?: string;
  docsUrl?: string;
  authKind: IntegrationAuthSpec["kind"];
  apiKeyLabel?: string;
  apiKeyHelp?: string;
  /** True when the operator has configured the credentials needed to connect. */
  configured: boolean;
  status: "connected" | "disconnected" | "error";
  accountLabel?: string;
  toolNames: string[];
}
