// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
// `bivy exec "<prompt>"` — one-shot, headless agent run for scripting and pipes.
// Creates (or resumes) a session, sends one prompt, waits for the turn to finish,
// prints the final answer to stdout, and exits. Working details stay on stderr so
// stdout is just the answer (pipe-friendly). `--json` emits a structured result.
//
//   bivy exec "summarize README.md"
//   bivy exec --agent claude "what does src/server.ts do?"
//   bivy exec --session <ref> "and now add a test"      # continue a session
//   echo "explain this" | bivy exec -                    # prompt from stdin

import { WebSocket } from "ws";

type Args = {
  url: string;
  token?: string;
  agent?: string;
  session?: string;
  prompt: string;
  json: boolean;
  timeoutMs: number;
};

const err = (s: string) => process.stderr.write(s);

function parseArgs(argv: string[]): Args {
  let url = process.env.BIVY_URL || `http://localhost:${process.env.PORT || "4317"}`;
  let token = process.env.BIVY_DEVICE_TOKEN || undefined;
  let agent: string | undefined;
  let session: string | undefined;
  let json = false;
  let timeoutMs = Number(process.env.BIVY_EXEC_TIMEOUT_MS) || 10 * 60 * 1000;
  const prompt: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url" && argv[i + 1]) url = argv[++i];
    else if (arg.startsWith("--url=")) url = arg.slice("--url=".length);
    else if (arg === "--token" && argv[i + 1]) token = argv[++i];
    else if (arg.startsWith("--token=")) token = arg.slice("--token=".length);
    else if ((arg === "-a" || arg === "--agent") && argv[i + 1]) agent = argv[++i];
    else if (arg.startsWith("--agent=")) agent = arg.slice("--agent=".length);
    else if (arg === "--session" && argv[i + 1]) session = argv[++i];
    else if (arg.startsWith("--session=")) session = arg.slice("--session=".length);
    else if (arg === "--json") json = true;
    else if (arg === "--timeout" && argv[i + 1]) timeoutMs = Number(argv[++i]) * 1000;
    else prompt.push(arg);
  }
  return { url: url.replace(/\/+$/, ""), token, agent, session, prompt: prompt.join(" "), json, timeoutMs };
}

function authHeaders(token?: string): Record<string, string> {
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function api<T>(url: string, token: string | undefined, pathName: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${url}${pathName}`, { ...init, headers: { ...authHeaders(token), ...(init.headers || {}) } });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error((data as { error?: string })?.error || `HTTP ${res.status} for ${pathName}`);
  return data;
}

function wsUrl(baseUrl: string, token?: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.search = token ? `?access_token=${encodeURIComponent(token)}` : "";
  return u.toString();
}

// Pull plain text out of a runtime message/content shape (mirrors the TUI).
function textContent(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textContent).filter(Boolean).join("");
  if (typeof value === "object") {
    const r = value as Record<string, unknown>;
    if (r.type === "thinking" || r.type === "reasoning") return "";
    if (typeof r.text === "string") return r.text;
    if (typeof r.content === "string" || Array.isArray(r.content)) return textContent(r.content);
    if (typeof r.output === "string") return r.output;
  }
  return "";
}

function assistantText(event: Record<string, unknown>): string {
  const message = event.message as { content?: unknown } | undefined;
  return textContent(message?.content ?? event.content ?? event.text);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let prompt = args.prompt.trim();
  if (prompt === "-" || (!prompt && !process.stdin.isTTY)) prompt = (await readStdin()).trim();
  if (!prompt) {
    err('Usage: bivy exec "<prompt>"  (or pipe the prompt on stdin)\n');
    process.exit(2);
  }

  // Establish the session — resume by ref or create fresh with the chosen agent.
  let sessionId: string;
  try {
    if (args.session) {
      const opened = await api<{ id: string }>(args.url, args.token, "/api/sessions/open", {
        method: "POST",
        body: JSON.stringify({ path: args.session, ...(args.agent ? { agent: args.agent } : {}) }),
      });
      sessionId = opened.id;
    } else {
      const created = await api<{ id: string }>(args.url, args.token, "/api/session", {
        method: "POST",
        body: JSON.stringify(args.agent ? { agent: args.agent } : {}),
      });
      sessionId = created.id;
    }
  } catch (error) {
    err(`Could not start a session: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
    return;
  }

  err(`\x1b[2m· session ${sessionId.slice(0, 8)} — working…\x1b[22m\n`);

  const socket = new WebSocket(wsUrl(args.url, args.token));
  let answer = "";
  let settled = false;

  const finish = (code: number, errorText?: string) => {
    if (settled) return;
    settled = true;
    try { socket.close(); } catch {}
    if (errorText) { err(`${errorText}\n`); process.exit(code); return; }
    if (args.json) process.stdout.write(JSON.stringify({ sessionId, answer }) + "\n");
    else process.stdout.write(answer.replace(/\s+$/, "") + "\n");
    process.exit(code);
  };

  const timer = setTimeout(() => finish(1, `Timed out after ${Math.round(args.timeoutMs / 1000)}s.`), args.timeoutMs);
  timer.unref?.();

  socket.on("open", async () => {
    try {
      await api(args.url, args.token, "/api/session/prompt", {
        method: "POST",
        body: JSON.stringify({ sessionId, text: prompt, clientMessageId: `exec-${sessionId}` }),
      });
    } catch (error) {
      finish(1, `Prompt failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  socket.on("error", (e) => finish(1, `Connection error: ${e instanceof Error ? e.message : String(e)}`));
  // A close here means the socket dropped before an `agent_end` event was ever
  // seen (a real completion calls finish(0) itself, closing the socket and
  // setting `settled` first — so this handler is then a no-op). That's always
  // abnormal: a mid-turn disconnect must exit non-zero even when partial
  // assistant text already streamed in, otherwise a script reading `answer`
  // (or just checking $?) sees a clean success for a truncated reply.
  socket.on("close", () => {
    if (settled) return;
    finish(1, answer ? "Connection closed before the turn finished (received a partial answer)." : "Connection closed before the turn finished.");
  });

  socket.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.sessionId && msg.sessionId !== sessionId) return;
    const type = msg.type;
    if (type === "session.event") {
      const ev = (msg.event || {}) as Record<string, unknown>;
      if (ev.type === "message_start" || ev.type === "message_update" || ev.type === "message_end") {
        const text = assistantText(ev);
        if (text) answer = text; // events carry the full message text so far
      } else if (ev.type === "agent_end") {
        clearTimeout(timer);
        finish(0);
      }
    } else if (type === "session.error") {
      clearTimeout(timer);
      finish(1, String(msg.error || "Session error"));
    }
  });
}

main().catch((error) => {
  err(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
