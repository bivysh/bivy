// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// Gemini CLI / Qwen Code on-disk session readers. Both agents persist JSON or
// JSONL conversations, but currently use different directory layouts. Keep the
// parser tolerant: upstream has migrated Gemini from whole-file JSON to
// append-only JSONL, while Qwen stores one JSONL transcript per session.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasLiveProcessForCwd } from "./native-process-scan.js";
import type { DiscoveredNativeSession, RuntimeMessage } from "./types.js";

export type GeminiFamilyAgent = "gemini" | "qwen";

export interface GeminiFamilySession {
  id: string;
  file: string;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  firstMessage?: string;
  messages: RuntimeMessage[];
}

function homeFor(agent: GeminiFamilyAgent): string {
  if (agent === "qwen") {
    return process.env.QWEN_RUNTIME_DIR?.trim() || process.env.QWEN_HOME?.trim() || path.join(os.homedir(), ".qwen");
  }
  return process.env.GEMINI_CLI_HOME?.trim() || path.join(os.homedir(), ".gemini");
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const rec = value as Record<string, unknown>;
  if (typeof rec.text === "string") return rec.text;
  if (rec.parts) return textOf(rec.parts);
  return "";
}

function epoch(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function projectRootNear(file: string): string | undefined {
  let dir = path.dirname(file);
  for (let i = 0; i < 4; i++) {
    try {
      const root = fs.readFileSync(path.join(dir, ".project_root"), "utf8").trim();
      if (root) return root;
    } catch { /* continue upward */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function parseRecords(file: string): GeminiFamilySession | undefined {
  let raw: string;
  let stat: fs.Stats;
  try {
    raw = fs.readFileSync(file, "utf8");
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }

  let records: unknown[];
  try {
    const whole = JSON.parse(raw) as Record<string, unknown>;
    records = [whole, ...(Array.isArray(whole.messages) ? whole.messages : [])];
  } catch {
    records = raw.split(/\r?\n/).filter((line) => line.trim()).flatMap((line) => {
      try { return [JSON.parse(line) as unknown]; } catch { return []; }
    });
  }

  let id: string | undefined;
  let cwd = projectRootNear(file);
  let createdAt: number | undefined;
  let updatedAt: number | undefined;
  const messages = new Map<string, RuntimeMessage>();
  let sequence = 0;

  const addMessage = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const rec = value as Record<string, unknown>;
    const type = rec.type ?? rec.role;
    if (type !== "user" && type !== "gemini" && type !== "assistant" && type !== "model") return;
    const content = rec.content ?? rec.message;
    const text = textOf(content).trim();
    if (!text) return;
    const role: RuntimeMessage["role"] = type === "user" ? "user" : "assistant";
    const key = typeof rec.id === "string" ? rec.id : `message-${sequence++}`;
    messages.set(key, { role, content: text, timestamp: epoch(rec.timestamp ?? rec.createdAt) });
  };

  for (const value of records) {
    if (!value || typeof value !== "object") continue;
    const rec = value as Record<string, unknown>;
    if (typeof rec.sessionId === "string") id = rec.sessionId;
    if (typeof rec.cwd === "string") cwd = rec.cwd;
    createdAt ??= epoch(rec.startTime ?? rec.createdAt ?? rec.timestamp);
    updatedAt = epoch(rec.lastUpdated ?? rec.updatedAt ?? rec.timestamp) ?? updatedAt;
    if (rec.$set && typeof rec.$set === "object") {
      const set = rec.$set as Record<string, unknown>;
      if (typeof set.sessionId === "string") id = set.sessionId;
      if (typeof set.cwd === "string") cwd = set.cwd;
      createdAt ??= epoch(set.startTime ?? set.createdAt);
      updatedAt = epoch(set.lastUpdated ?? set.updatedAt) ?? updatedAt;
      if (Array.isArray(set.messages)) for (const message of set.messages) addMessage(message);
    }
    if (typeof rec.$rewindTo === "string") {
      let remove = false;
      for (const key of [...messages.keys()]) {
        if (key === rec.$rewindTo) remove = true;
        if (remove) messages.delete(key);
      }
      continue;
    }
    addMessage(rec);
  }

  // Qwen names transcripts by the full session id. Gemini's filename contains
  // only a short id, so require its metadata instead of inventing an unusable ref.
  if (!id && /^[0-9a-f-]{16,}\.jsonl$/i.test(path.basename(file))) id = path.basename(file, ".jsonl");
  if (!id) return undefined;
  const out = [...messages.values()];
  const first = out.find((message) => message.role === "user");
  return {
    id,
    file,
    cwd,
    createdAt: createdAt ?? (stat.birthtimeMs || stat.mtimeMs),
    updatedAt: updatedAt ?? stat.mtimeMs,
    firstMessage: typeof first?.content === "string" ? first.content.slice(0, 120) : undefined,
    messages: out,
  };
}

function sessionFiles(agent: GeminiFamilyAgent): string[] {
  const home = homeFor(agent);
  const roots = agent === "qwen" ? [path.join(home, "projects")] : [path.join(home, "tmp")];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth < 0) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth - 1);
      else if (entry.isFile() && /\.jsonl?$/.test(entry.name) && !entry.name.endsWith(".ledger.jsonl")) {
        const parent = path.basename(path.dirname(full));
        if (parent === "chats" || path.basename(path.dirname(path.dirname(full))) === "chats") out.push(full);
      }
    }
  };
  for (const root of roots) walk(root, 4);
  return out;
}

export function listGeminiFamilySessions(agent: GeminiFamilyAgent): GeminiFamilySession[] {
  return sessionFiles(agent)
    .map(parseRecords)
    .filter((session): session is GeminiFamilySession => Boolean(session))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export function loadGeminiFamilyTranscript(agent: GeminiFamilyAgent, sessionId: string): RuntimeMessage[] {
  return listGeminiFamilySessions(agent).find((session) => session.id === sessionId)?.messages ?? [];
}

export function discoverGeminiFamilySessionForCwd(agent: GeminiFamilyAgent, cwd: string, since: number): GeminiFamilySession | undefined {
  const target = path.resolve(cwd);
  const earliest = since - 10_000;
  return listGeminiFamilySessions(agent)
    .filter((session) => session.cwd && path.resolve(session.cwd) === target && (session.createdAt ?? 0) >= earliest)
    .sort((a, b) => Math.abs((a.createdAt ?? 0) - since) - Math.abs((b.createdAt ?? 0) - since))[0];
}

export function discoverNativeGeminiFamilySessions(agent: GeminiFamilyAgent): DiscoveredNativeSession[] {
  return listGeminiFamilySessions(agent).map((session) => ({
    runtimeId: agent,
    ref: session.id,
    file: session.file,
    cwd: session.cwd,
    updatedAt: session.updatedAt ?? session.createdAt,
    title: session.firstMessage,
    active: Boolean(session.cwd) && hasLiveProcessForCwd(session.cwd!, agent === "gemini" ? ["gemini"] : ["qwen", "qwen-code"]),
    resumable: true,
  }));
}
