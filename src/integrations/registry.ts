// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { Type } from "typebox";
import type { IntegrationDef, IntegrationToolResult } from "./types.js";

// ---------------------------------------------------------------------------
// Built-in integrations.
//
// Each entry is fully declarative: an auth spec + a handful of tools. The tool
// `execute` receives an already-authenticated `http` helper (auth header +
// baseUrl + token refresh handled by the manager), so a tool is usually a
// single fetch + format. To add a service, append one object to this array.
// ---------------------------------------------------------------------------

function text(s: string, details?: Record<string, unknown>): IntegrationToolResult {
  return { content: [{ type: "text", text: s }], details };
}

function toRfc822({ to, subject, body }: { to: string; subject: string; body: string }) {
  const lines = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=UTF-8", "", body];
  return Buffer.from(lines.join("\r\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const BUILT_IN_INTEGRATIONS: IntegrationDef[] = [
  {
    id: "notion",
    name: "Notion",
    description: "Search your Notion workspace and read pages.",
    icon: "📝",
    docsUrl: "https://www.notion.so/my-integrations",
    baseUrl: "https://api.notion.com/v1",
    auth: {
      kind: "apiKey",
      label: "Notion internal integration token",
      help: "Create an internal integration at notion.so/my-integrations, then share the pages you want reachable with it.",
      placeholder: "secret_…",
    },
    tools: [
      {
        name: "notion_search",
        label: "Notion: Search",
        description: "Search pages and databases shared with the Notion integration.",
        parameters: Type.Object({ query: Type.String({ description: "Search text" }) }),
        async execute(params, http) {
          const data = await http.json<any>("/search", {
            method: "POST",
            headers: { "Notion-Version": "2022-06-28" },
            body: JSON.stringify({ query: params.query, page_size: 10 }),
          });
          const results = (data.results ?? []).map((r: any) => {
            const title =
              r?.properties?.title?.title?.[0]?.plain_text ||
              r?.properties?.Name?.title?.[0]?.plain_text ||
              r?.title?.[0]?.plain_text ||
              "(untitled)";
            return `- ${title} [${r.object}] ${r.url ?? r.id}`;
          });
          return text(results.length ? results.join("\n") : "No matches.", { count: results.length });
        },
      },
      {
        name: "notion_get_page",
        label: "Notion: Read page",
        description: "Read the block contents of a Notion page by id.",
        parameters: Type.Object({ pageId: Type.String({ description: "Notion page id" }) }),
        async execute(params, http) {
          const data = await http.json<any>(`/blocks/${encodeURIComponent(params.pageId)}/children?page_size=100`, {
            headers: { "Notion-Version": "2022-06-28" },
          });
          const lines = (data.results ?? []).flatMap((b: any) => {
            const rich = b?.[b.type]?.rich_text;
            return Array.isArray(rich) ? rich.map((t: any) => t.plain_text).join("") : [];
          });
          return text(lines.filter(Boolean).join("\n") || "(no readable text blocks)");
        },
      },
    ],
  },

  {
    id: "google",
    name: "Google (Gmail)",
    description: "Search and send Gmail. The same connection covers other Google APIs (Docs, Drive).",
    icon: "✉️",
    docsUrl: "https://console.cloud.google.com/apis/credentials",
    baseUrl: "https://gmail.googleapis.com/gmail/v1",
    auth: {
      kind: "oauth2",
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientIdEnv: "BIVY_GOOGLE_CLIENT_ID",
      clientSecretEnv: "BIVY_GOOGLE_CLIENT_SECRET",
      pkce: true,
      // offline + consent so Google returns a refresh token.
      extraAuthParams: { access_type: "offline", prompt: "consent" },
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
      async accountLabel(http) {
        try {
          const me = await http.json<any>("https://www.googleapis.com/oauth2/v2/userinfo");
          return me?.email;
        } catch {
          return undefined;
        }
      },
    },
    tools: [
      {
        name: "gmail_search",
        label: "Gmail: Search",
        description: "Search Gmail messages and return subjects and snippets. Supports Gmail query syntax.",
        parameters: Type.Object({
          query: Type.String({ description: "Gmail search query, e.g. 'from:boss is:unread'" }),
          max: Type.Optional(Type.Number({ description: "Max messages (default 5)" })),
        }),
        async execute(params, http) {
          const max = Math.min(Math.max(Number(params.max) || 5, 1), 20);
          const list = await http.json<any>(`/users/me/messages?maxResults=${max}&q=${encodeURIComponent(params.query)}`);
          const ids = (list.messages ?? []).map((m: any) => m.id);
          const summaries: string[] = [];
          for (const id of ids) {
            const msg = await http.json<any>(`/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`);
            const headers = msg.payload?.headers ?? [];
            const subject = headers.find((h: any) => h.name === "Subject")?.value ?? "(no subject)";
            const from = headers.find((h: any) => h.name === "From")?.value ?? "";
            summaries.push(`- ${subject} — ${from}\n  ${msg.snippet ?? ""}`);
          }
          return text(summaries.length ? summaries.join("\n") : "No messages matched.", { count: summaries.length });
        },
      },
      {
        name: "gmail_send",
        label: "Gmail: Send",
        description: "Send a plain-text email from the connected Gmail account.",
        risky: true,
        parameters: Type.Object({
          to: Type.String({ description: "Recipient email address" }),
          subject: Type.String(),
          body: Type.String({ description: "Plain text body" }),
        }),
        async execute(params, http) {
          const raw = toRfc822(params);
          const res = await http.json<any>("/users/me/messages/send", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ raw }),
          });
          return text(`Sent. Message id ${res.id}.`, { id: res.id });
        },
      },
    ],
  },

  {
    id: "dropbox",
    name: "Dropbox",
    description: "List and read files in your Dropbox.",
    icon: "📦",
    docsUrl: "https://www.dropbox.com/developers/apps",
    baseUrl: "https://api.dropboxapi.com/2",
    auth: {
      kind: "oauth2",
      authUrl: "https://www.dropbox.com/oauth2/authorize",
      tokenUrl: "https://api.dropboxapi.com/oauth2/token",
      clientIdEnv: "BIVY_DROPBOX_CLIENT_ID",
      clientSecretEnv: "BIVY_DROPBOX_CLIENT_SECRET",
      // offline so Dropbox returns a refresh token (its access tokens are short-lived).
      extraAuthParams: { token_access_type: "offline" },
      scopes: ["account_info.read", "files.metadata.read", "files.content.read"],
      async accountLabel(http) {
        try {
          const acct = await http.json<any>("/users/get_current_account", { method: "POST" });
          return acct?.email || acct?.name?.display_name;
        } catch {
          return undefined;
        }
      },
    },
    tools: [
      {
        name: "dropbox_list_folder",
        label: "Dropbox: List folder",
        description: "List entries in a Dropbox folder. Use an empty path for the root.",
        parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Folder path, e.g. '/Documents'. Empty = root." })) }),
        async execute(params, http) {
          const data = await http.json<any>("/files/list_folder", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: params.path ? params.path : "" }),
          });
          const entries = (data.entries ?? []).map((e: any) => `- [${e[".tag"]}] ${e.path_display}`);
          return text(entries.length ? entries.join("\n") : "(empty)", { count: entries.length });
        },
      },
      {
        name: "dropbox_read_file",
        label: "Dropbox: Read file",
        description: "Download a text file from Dropbox and return its contents.",
        parameters: Type.Object({ path: Type.String({ description: "Full file path, e.g. '/notes.txt'" }) }),
        async execute(params, http) {
          const res = await http("https://content.dropboxapi.com/2/files/download", {
            method: "POST",
            headers: { "Dropbox-API-Arg": JSON.stringify({ path: params.path }) },
          });
          if (!res.ok) return { content: [{ type: "text", text: `Download failed (${res.status})` }], isError: true };
          const body = await res.text();
          return text(body.slice(0, 20000));
        },
      },
    ],
  },

  {
    id: "github",
    name: "GitHub",
    description: "Search issues/PRs and read repository files.",
    icon: "🐙",
    docsUrl: "https://github.com/settings/tokens",
    baseUrl: "https://api.github.com",
    auth: {
      kind: "apiKey",
      label: "GitHub personal access token",
      help: "Create a fine-grained or classic token with repo read scope at github.com/settings/tokens.",
      placeholder: "github_pat_…",
    },
    tools: [
      {
        name: "github_search_issues",
        label: "GitHub: Search issues",
        description: "Search issues and pull requests across GitHub using the issues search syntax.",
        parameters: Type.Object({ query: Type.String({ description: "e.g. 'repo:owner/name is:open label:bug'" }) }),
        async execute(params, http) {
          const data = await http.json<any>(`/search/issues?per_page=10&q=${encodeURIComponent(params.query)}`, {
            headers: { accept: "application/vnd.github+json" },
          });
          const items = (data.items ?? []).map((i: any) => `- #${i.number} ${i.title} [${i.state}] ${i.html_url}`);
          return text(items.length ? items.join("\n") : "No results.", { total: data.total_count });
        },
      },
    ],
  },
];
